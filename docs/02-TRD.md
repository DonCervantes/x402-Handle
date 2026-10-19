# TRD — Flovia Stellar

**Versión:** 0.1
**Companion to:** `01-PRD.md`

---

## 1. Visión arquitectónica

Flovia mantiene la estructura de **monorepo Bun** del POC original, pero **reemplaza completamente la capa de fuentes** (anteriormente Solana/EVM) por una capa Stellar-nativa, e introduce dos componentes nuevos:

1. **Middleware x402-Stellar** (`code/x402-stellar-middleware/`) — paquete instalable que cualquier servidor HTTP puede usar para cobrar por endpoints.
2. **Contrato Soroban** (`code/soroban-registry/`) — fuente de verdad on-chain de los proveedores y sus pagos.

```
┌────────────────────────────────────────────────────────────────┐
│                    AGENTES AUTÓNOMOS                           │
│              (LLMs, bots, workflows)                           │
└──────────────────┬─────────────────────────────────────────────┘
                   │  HTTPS + @flovia/agent-sdk
                   ▼
┌────────────────────────────────────────────────────────────────┐
│                    apps/bff  (Bun + Hono)                      │
│  /providers   /recommend   /pay   /providers/:id/intelligence  │
└──────┬─────────────┬──────────────┬──────────────┬─────────────┘
       │             │              │              │
       ▼             ▼              ▼              ▼
┌─────────────┐ ┌─────────┐ ┌─────────────┐ ┌──────────────┐
│  intel.     │ │ sources │ │  contracts  │ │  Anthropic   │
│  (Trust,    │ │ (Stellar│ │  (Zod)      │ │  Claude API  │
│   AI prompt)│ │  SDK)   │ │             │ │              │
└──────┬──────┘ └────┬────┘ └─────────────┘ └──────────────┘
       │             │
       ▼             ▼
┌──────────────────────────────────────────────────────────────┐
│   STELLAR TESTNET                                            │
│   ┌────────────┐  ┌────────────────┐  ┌──────────────────┐   │
│   │  Horizon   │  │  Soroban RPC   │  │ Soroban Contract │   │
│   │  (REST)    │  │  (JSON-RPC)    │  │   (Registry)     │   │
│   └────────────┘  └────────────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────────────┘
       ▲                       ▲
       │                       │
       │           ┌───────────┴──────────┐
       │           │ apps/cli  (indexer)  │
       │           │ corre cada N segundos│
       │           └──────────────────────┘
       │
┌──────┴─────────────┐
│  Postgres (apps/data)│
└──────────────────────┘
```

## 2. Stack tecnológico definitivo

### 2.1 Lenguajes y runtimes
- **TypeScript 5.x** — todo el backend y frontend.
- **Rust** (edición 2021) — contrato Soroban.
- **Bun** ≥ 1.1 — runtime de TS, package manager.

### 2.2 Librerías clave
| Capa | Librería | Versión orientativa | Por qué |
|---|---|---|---|
| Stellar SDK | `@stellar/stellar-sdk` | ^12.x | SDK oficial, soporta Horizon + Soroban |
| Soroban CLI | `stellar-cli` (binario) | última | Deploy y test de contratos |
| Soroban SDK | `soroban-sdk` (Rust) | ^21.x | Para escribir el contrato |
| HTTP server | `hono` | ^4.x | Liviano, type-safe, compatible Bun |
| DB ORM | `drizzle-orm` | ^0.30 | Type-safe, migrations |
| Validación | `zod` | ^3.x | Ya en uso en el repo |
| Frontend | `next` | 14.x | App router |
| UI | `tailwindcss` + `shadcn/ui` | última | Velocidad de desarrollo |
| Charts | `recharts` | ^2.x | Gráficos del dashboard |
| LLM | `@anthropic-ai/sdk` | ^0.27 | Recomendaciones |

### 2.3 Infraestructura
- **Postgres 16** local vía Docker.
- **Vercel** para el frontend.
- **Railway** o **Fly.io** para el BFF (sólo necesitamos demo durante evaluación).
- **GitHub Actions** para CI (lint + test).

## 3. Modelo de datos

### 3.1 On-chain (Soroban storage)
Detalle completo en `code/soroban-registry/src/lib.rs`. Resumen:

```rust
struct Provider {
    owner: Address,         // cuenta que registró el proveedor
    name: String,           // "FX Rates Oracle"
    endpoint: String,       // "https://fx.example.com/rate"
    price_stroops: u64,     // precio por call, en stroops de USDC
    payment_token: Address, // contrato del activo (USDC)
    metadata_hash: BytesN<32>, // hash de metadata extendida (IPFS / JSON)
    created_at: u64,
    active: bool,
}

struct PaymentLog {
    provider_id: u64,
    payer: Address,
    amount: u64,
    tx_hash: BytesN<32>,
    timestamp: u64,
}
```

Storage:
- `providers: Map<u64, Provider>`
- `payments: Vec<PaymentLog>` (limitado, expira)
- Eventos: `provider_registered`, `payment_logged`

### 3.2 Off-chain (Postgres)
Las tablas espejean el on-chain + agregan capas analíticas. Ver `05-BACKEND-ESQUEMATICO.md` para SQL completo.

```
providers           → espejo de Soroban + datos enriquecidos
provider_metadata   → identidad, KYB, verificación
payments            → log enriquecido (precio, tx_hash, latencia)
trust_score_history → snapshots periódicos del score
ai_recommendations  → cache de respuestas LLM
```

## 4. Contratos de datos (Zod, `packages/contracts`)

Los tipos del POC original que se mantienen casi iguales:

```ts
// packages/contracts/src/provider.ts
export const ProviderSchema = z.object({
  id: z.string(), // contract id + provider_id
  name: z.string(),
  endpoint: z.string().url(),
  priceUsdc: z.number().positive(),
  ownerAccount: z.string(), // G... Stellar address
  paymentAsset: z.literal("USDC"),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  metadata: ProviderMetadataSchema,
});

// Nuevo: composición de las 7 capas
export const ProviderIntelligenceSchema = z.object({
  provider: ProviderSchema,
  identity: IdentitySchema,         // capa 2
  verification: VerificationSchema, // capa 3
  finance: FinanceSchema,           // capa 4
  trustScore: TrustScoreSchema,     // capa 5
  aiInsight: AIInsightSchema.optional(), // capa 6
});
```

Tipos eliminados del repo viejo (Solana-specific):
- `SolanaWallet`, `BitqueryAggregate` (se reescriben como `StellarAccount`, `HorizonAggregate`).
- `CdpResource` (no aplica).

## 5. APIs del BFF

Resumen (detalle en `05-BACKEND-ESQUEMATICO.md`):

```
GET    /providers                        listado con filtros
GET    /providers/:id                    detalle 7 capas
GET    /providers/:id/intelligence       payload completo para UI
GET    /api/recommend                    motor de recomendación
POST   /api/pay/prepare                  arma tx para que el agente firme
POST   /api/pay/verify                   verifica tx submitted
GET    /accounts/:G/intelligence         perfil de cualquier cuenta Stellar
GET    /stats/overview                   métricas globales del dashboard
```

## 6. Flujo crítico: pago x402-Stellar end-to-end

```
1. Agente: GET https://provider.com/data
2. Provider middleware: no hay header X-PAYMENT
   → responde 402 con body:
     {
       "version": "x402-stellar-1",
       "network": "testnet",
       "asset": { "code": "USDC", "issuer": "GA5Z..." },
       "amount": "0.01",
       "destination": "GBPROVIDER...",
       "memo": "f1c2-call-id",
       "expires_at": "2026-06-29T18:00:00Z"
     }
3. Agente (vía SDK): construye payment operation, firma con su seed
4. Agente: submit a Horizon
5. Horizon: confirma tx (~5s)
6. Agente: GET https://provider.com/data
   Header: X-PAYMENT: <tx_hash>
7. Middleware: consulta Horizon por tx_hash
   - Valida: destino, asset, monto, memo, no usado antes
8. Middleware: marca tx_hash como consumido (cache local + Soroban log opcional)
9. Middleware: sirve el recurso
```

Edge cases manejados:
- Pago duplicado (idempotencia) → cache de tx_hashes consumidos.
- Pago insuficiente → 402 con nuevo monto.
- Pago expirado → 402.
- Underpayment / overpayment → política configurable (default: estricto).

## 7. Trust Score: especificación

Fórmula (transparente y documentada en UI):

```
TrustScore = w1·age + w2·volume + w3·kyb + w4·claims + w5·recency

Donde:
  age      = min(1, days_since_registered / 90)      peso w1 = 0.15
  volume   = min(1, log10(usdc_volume_30d + 1) / 4)  peso w2 = 0.30
  kyb      = 1.0 si verified, 0.3 si pending, 0 si no  peso w3 = 0.30
  claims   = 1 - min(1, disputes / payments)          peso w4 = 0.15
  recency  = 1.0 si activo en 7d, 0.5 si 30d, 0 si más  peso w5 = 0.10

Score final = round(100 · sum(pesos · factores))
```

Implementación en `packages/intelligence/trust.ts`. Cada componente se persiste para auditabilidad.

## 8. Seguridad

- **Private keys** sólo en `.env`, nunca commiteadas. `.env.example` documenta variables.
- **CORS**: BFF acepta sólo origins configurados.
- **Rate limiting** en `/api/recommend` (caro por uso de LLM): 30 req/min por IP.
- **Verificación de tx en x402**: siempre del lado del servidor consultando Horizon, nunca confiar en lo que envía el cliente.
- **Memo único** por challenge: previene replay attacks aunque mismo monto/destino.
- **Contrato Soroban**: `register_provider` exige `require_auth()` del owner; `log_payment` exige autorización del owner del provider o un oracle habilitado, y registra el precio configurado del provider.

## 9. Variables de entorno

```
# Stellar
STELLAR_NETWORK=testnet                # o "public"
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
USDC_ASSET_CODE=USDC
USDC_ASSET_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5  # testnet issuer
REGISTRY_CONTRACT_ID=C...              # output de soroban deploy

# Cuentas demo
DEMO_AGENT_SECRET=S...                 # nunca commitear
DEMO_PROVIDER_SECRET=S...

# BFF
BFF_PORT=4000
BFF_BASE_URL=http://localhost:4000
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://localhost/flovia
RECOMMEND_RATE_LIMIT_PER_MIN=30

# Frontend
NEXT_PUBLIC_BFF_URL=http://localhost:4000
```

## 10. Testing

- **Unit tests** en `packages/intelligence` (Trust Score determinístico).
- **Integration test** de middleware x402: levanta server fake, hace flujo completo en testnet.
- **Contract tests**: Soroban tests en Rust (`#[cfg(test)]`) con `soroban-sdk-testutils`.
- **Smoke test** del flujo demo: script `cli/scripts/demo.ts` que ejecuta el journey completo y reporta éxito/fallo. Se corre antes de cada presentación.

## 11. Observabilidad

Para el hackathon, mínimo viable:
- **Logs estructurados** (`pino`) en el BFF.
- **Página `/status`** que muestra: última conexión a Horizon, contract id, # providers cacheados.
- Sin métricas Prometheus por ahora (queda en roadmap).

## 12. Decisiones de diseño y trade-offs

| Decisión | Alternativa rechazada | Razón |
|---|---|---|
| USDC nativo como único activo | XLM, multi-asset | USDC es lo que un agente "entiende" como dinero estable. Multi-asset agrega complejidad sin valor demo. |
| Memo en challenge x402 | Sin memo, sólo amount+dest | El memo permite identificar el call específico → idempotencia limpia. |
| Registry on-chain (Soroban) | Registry off-chain (Postgres only) | El registry on-chain es lo que vuelve a Flovia "Stellar-native" y abre composabilidad. |
| Indexer pull-based en CLI | Push (webhooks) | Más simple para hackathon; webhooks de Horizon requieren más infra. |
| Trust Score determinístico | Modelo ML | Auditabilidad > sofisticación en POC. ML queda en roadmap. |
