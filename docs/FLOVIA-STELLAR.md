# Flovia Stellar — Documentación Maestra del Proyecto

> **Repositorio base:** `gh repo clone DonCervantes/poc`
> **Hackathon:** Stellar Community Fund (SCF)
> **Alcance del hackathon:** 100% Stellar, 100% testnet, < 1 semana
> **Owner:** DonCervantes

Este documento concentra **toda** la documentación del proyecto en un solo archivo navegable. Está pensado para ser leído por humanos *y* por Claude Code como contexto único de trabajo.

---

## Tabla de contenido

- [Parte 0 — Cómo usar este documento](#parte-0--cómo-usar-este-documento)
- [Parte 1 — PRD (Product Requirements)](#parte-1--prd-product-requirements)
- [Parte 2 — TRD (Technical Requirements)](#parte-2--trd-technical-requirements)
- [Parte 3 — UI / UX](#parte-3--ui--ux)
- [Parte 4 — Flujo de página](#parte-4--flujo-de-página)
- [Parte 5 — Backend esquemático](#parte-5--backend-esquemático)
- [Parte 6 — Plan de implementación](#parte-6--plan-de-implementación)
- [Parte 7 — Business Plan](#parte-7--business-plan)
- [Parte 8 — Pitch Deck](#parte-8--pitch-deck)
- [Parte 9 — White Paper](#parte-9--white-paper)
- [Parte 10 — Pitch SCF (7 capas)](#parte-10--pitch-scf-7-capas)
- [Parte 11 — Migración de `packages/sources`](#parte-11--migración-de-packagessources)
- [Parte 12 — Código inicial provisto](#parte-12--código-inicial-provisto)

---

## Parte 0 — Cómo usar este documento

### Orden de lectura sugerido
1. **Parte 10** (visión: las 7 capas).
2. **Parte 1** (qué construimos).
3. **Parte 6** (plan día por día).
4. **Parte 2** + **Parte 5** (arquitectura técnica).
5. **Parte 11** + **Parte 12** (al codear).

### Stack confirmado
- **Cadena:** Stellar testnet (mainnet llega en milestone 1 post-grant).
- **Smart contracts:** Soroban (Rust).
- **Activo de pago:** USDC nativo en Stellar.
- **SDK:** `@stellar/stellar-sdk` (TS) + `soroban-sdk` (Rust).
- **Runtime:** Bun (mismo que el POC).
- **Frontend:** Next.js 14 App Router.
- **DB:** Postgres.
- **LLM:** Anthropic Claude.

### Convenciones
- Direcciones Stellar: `G...` (public, 56 chars), `S...` (secret seed).
- Contract IDs Soroban: `C...`.
- Stroops = 1 / 10^7 de la unidad humana. USDC tiene 7 decimales.

---


---

## Parte 1 — PRD (Product Requirements)


**Versión:** 0.1 (Hackathon SCF)
**Fecha:** Semana del hackathon
**Owner:** DonCervantes

---

### 1. Resumen ejecutivo

Flovia Stellar es una **plataforma de inteligencia para la economía de pagos agénticos** construida nativamente sobre la red Stellar. Resuelve un problema que está apareciendo *ahora*: cuando agentes autónomos (bots, LLMs con herramientas, workflows automatizados) necesitan pagar por servicios, no tienen forma de saber **quién es confiable, qué cobra, qué tan bueno es**, ni mucho menos de **descubrir y seleccionar el mejor proveedor automáticamente**.

Flovia es la capa que llena ese vacío: descubre proveedores, los verifica, los puntúa, y expone una API que los agentes consumen para tomar decisiones de pago en tiempo real.

### 2. Problema

#### 2.1 El cambio de paradigma
Los pagos ya no son sólo humano→humano o humano→empresa. Empiezan a ser **agente→API**, **agente→agente**. Un LLM que necesita datos de mercado, un bot que reserva un vuelo, un workflow que compra cómputo — todos ellos necesitan pagar, y a menudo en montos micro y a frecuencia alta.

#### 2.2 La fricción actual en Stellar
1. **No hay forma estándar de cobrar por API** de modo nativo en Stellar (no existe un x402 listo para usar).
2. **No hay forma de evaluar al proveedor** antes de pagarle. ¿Esa cuenta es real? ¿Cumplió antes? ¿Tiene KYB?
3. **No hay forma para el agente de descubrir** qué APIs existen, qué cobran, qué cubren.
4. **Los datos están dispersos:** Horizon, anchors, StellarExpert, contratos Soroban — nadie los une en una vista útil para decisión de pago.

#### 2.3 ¿Por qué esto importa ahora?
La adopción de agentes IA con capacidad de ejecutar pagos está explotando (MCP, function calling, Computer Use). Stellar tiene la mejor primitiva de pago (USDC nativo, fees ~0, finalidad de 5 segundos) pero **le falta la capa de inteligencia que vuelva esos pagos seguros y selectivos**. Quien construya esa capa se vuelve infraestructura crítica del ecosistema.

### 3. Solución

Flovia entrega **siete capas** integradas. Cada capa es un módulo independiente con interfaces definidas:

| Capa | Función | Estado en hackathon |
|---|---|---|
| 1. Descubrimiento de pagos | Indexa APIs que aceptan pagos x402 sobre Stellar | **Real** |
| 2. Identidad | Resuelve quién está detrás de cada cuenta/contrato | **Stub estructurado** |
| 3. Verificación (KYB/KYC) | Marca proveedores como verificados vía SEP-12 / anchors | **Stub estructurado** |
| 4. Inteligencia financiera | Análisis de actividad, volumen, paths, FX, costos | **Real** |
| 5. Reputación | Trust Score on-chain transparente | **Real (versión simple)** |
| 6. IA | Recomendaciones accionables vía Claude | **Real** |
| 7. Infraestructura para agentes | API + SDK para que agentes consulten y decidan | **Real** |

(Detalle expandido en `10-SCF-PITCH-7-CAPAS.md`.)

### 4. Usuarios y stakeholders

#### 4.1 Usuario primario: el **agente autónomo**
- Es código (LLM con herramientas, bot, workflow).
- Necesita ejecutar pagos en USDC-Stellar para consumir servicios.
- Su "decisión" es una llamada a la API de Flovia: "dame el mejor proveedor para X bajo restricciones Y".

#### 4.2 Usuario secundario: el **desarrollador del agente**
- Persona humana que construye el agente.
- Usa el dashboard de Flovia para inspeccionar, debuggear, configurar políticas (max budget, KYB obligatorio, etc.).

#### 4.3 Usuario terciario: el **proveedor de API**
- Quiere monetizar su servicio cobrando por uso.
- Se registra en Flovia, instala el middleware x402, aparece en el catálogo y empieza a recibir pagos.

#### 4.4 Stakeholders externos
- **Stellar Development Foundation / SCF reviewers** — necesitan ver visión Stellar-native + tracción + viabilidad técnica.
- **Anchors y exchanges** — fuente de verificación KYB.
- **Operadores de wallets** — potenciales integradores.

### 5. Objetivos del hackathon

#### 5.1 Objetivos primarios (must-have al cierre)
1. **Demo en vivo de un flujo end-to-end:** agente pregunta → Flovia recomienda → agente paga vía x402-Stellar → consume API. Todo en testnet, todo on-chain verificable.
2. **Contrato Soroban deployado en testnet** con registry + payment log funcionando.
3. **Dashboard web** mostrando proveedores con sus 7 capas de información.
4. **Documentación SCF-ready:** PRD, white paper resumido, video de 3 min, roadmap.

#### 5.2 Objetivos secundarios (nice-to-have)
- SDK cliente para agentes (TypeScript) publicado en npm como `@flovia/agent-sdk`.
- Integración con un anchor real de Stellar (aunque sea mock) para mostrar el path de KYB.
- 3 proveedores demo reales mapeados en el catálogo.

#### 5.3 No-objetivos (explícitamente fuera de scope esta semana)
- Mainnet (todo en testnet).
- Soporte multi-chain.
- Sistema de pagos recurrentes / streaming (queda como roadmap).
- Marketplace bidireccional (un proveedor publicando precios dinámicos). Esta vez los precios son fijos en el registry.
- Auth de usuarios humanos en el dashboard (es lectura pública por ahora).

### 6. Requisitos funcionales (RF)

#### RF-1 — Registro de proveedor
Como proveedor, quiero registrar mi servicio en el contrato Soroban con: nombre, URL, precio por call, cuenta de cobro, metadata.
- **Aceptación:** método `register_provider` del contrato emite evento `ProviderRegistered` y el indexer lo persiste en Postgres.

#### RF-2 — Cobro x402
Como proveedor, quiero proteger un endpoint HTTP con el middleware x402-Stellar.
- **Aceptación:** request sin pago → respuesta 402 con challenge. Request con `X-PAYMENT` válido → verificación en Horizon → recurso servido. Pago inválido o insuficiente → 402 nuevamente.

#### RF-3 — Catálogo público
Como visitante del dashboard, quiero ver la lista de proveedores con: nombre, precio, Trust Score, KYB flag, volumen últimas 24h.
- **Aceptación:** página `/providers` lista al menos 5 proveedores con datos reales.

#### RF-4 — Perfil de proveedor
Como visitante, quiero entrar al detalle de un proveedor y ver las 7 capas de información.
- **Aceptación:** página `/providers/[id]` muestra secciones: Descubrimiento, Identidad, Verificación, Inteligencia financiera, Trust Score (con desglose), Recomendación IA, Cómo consumir desde un agente.

#### RF-5 — Recomendación para agente
Como agente, quiero llamar a `GET /api/recommend?need=fx-rates&max_price=0.01&kyb_required=true` y recibir una lista ranqueada de proveedores con justificación.
- **Aceptación:** endpoint responde JSON estructurado, devuelve top 3, incluye campo `reasoning` generado por Claude.

#### RF-6 — Trust Score transparente
Como visitante, quiero entender cómo se calcula el Trust Score.
- **Aceptación:** la UI muestra el desglose por factor (antigüedad, volumen, KYB, claims) con el peso y el valor de cada uno.

#### RF-7 — Ejecución de pago desde agente
Como agente con el SDK, quiero llamar a `flovia.pay(providerId, callData)` y que el SDK construya, firme y envíe la transacción Stellar, y luego ejecute el call HTTP con el header `X-PAYMENT`.
- **Aceptación:** un script CLI de ejemplo ejecuta este flujo completo en menos de 10 segundos.

### 7. Requisitos no funcionales (RNF)

| ID | Requisito | Métrica |
|---|---|---|
| RNF-1 | Latencia de recomendación | < 2 s p95 |
| RNF-2 | Latencia de verificación x402 | < 6 s p95 (limitado por finalidad Stellar ~5s) |
| RNF-3 | Disponibilidad demo | 99% durante la semana de evaluación SCF |
| RNF-4 | Open source | Repo público en GitHub bajo MIT |
| RNF-5 | Reproducibilidad | `bun install && bun dev` levanta todo en local en < 2 min |
| RNF-6 | Seguridad | Sin private keys en código; usar `.env` con `.env.example` |

### 8. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Soroban testnet inestable durante demo | Media | Alto | Tener fallback grabado en video |
| Tiempo de aprendizaje SDK Stellar | Media | Medio | Día 1 dedicado a setup, ejemplos oficiales como referencia |
| Sobre-scope (querer construir las 7 capas reales) | Alta | Alto | Plan de día 6 estricto, stubs claramente marcados |
| Reviewer SCF no entiende x402 | Baja | Medio | Video explicativo + sección dedicada en pitch deck |

### 9. Métricas de éxito

#### 9.1 Métricas del hackathon (corto plazo)
- ✅ Demo en vivo funciona sin caídas.
- ✅ Repo público con README claro.
- ✅ Aplicación a SCF enviada con todos los entregables.

#### 9.2 Métricas post-hackathon (visión)
- N° de proveedores registrados en el contrato.
- USDC transado vía middleware x402 (volumen).
- N° de agentes únicos que consultan la API de recomendación.
- N° de integraciones con wallets/anchors.

### 10. Glosario

- **Agente:** programa autónomo (típicamente LLM-driven) que ejecuta acciones, incluidos pagos.
- **x402:** propuesta de protocolo que reutiliza HTTP 402 (Payment Required) para cobrar por recursos web. Es agnóstico de cadena; esta versión liquida sobre Stellar.
- **SEP:** Stellar Ecosystem Proposal. Estándares de Stellar (SEP-10 auth, SEP-12 KYC, SEP-31 cross-border, etc.).
- **Anchor:** entidad que conecta Stellar con el mundo fiat (on/off ramps), regulada y con KYB.
- **Soroban:** plataforma de smart contracts de Stellar.
- **Trust Score:** puntaje 0-100 calculado por Flovia para cada proveedor.
- **USDC en Stellar:** versión nativa de USDC emitida por Circle directamente en la red Stellar.


---

## Parte 2 — TRD (Technical Requirements)


**Versión:** 0.1
**Companion to:** `01-PRD.md`

---

### 1. Visión arquitectónica

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

### 2. Stack tecnológico definitivo

#### 2.1 Lenguajes y runtimes
- **TypeScript 5.x** — todo el backend y frontend.
- **Rust** (edición 2021) — contrato Soroban.
- **Bun** ≥ 1.1 — runtime de TS, package manager.

#### 2.2 Librerías clave
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

#### 2.3 Infraestructura
- **Postgres 16** local vía Docker.
- **Vercel** para el frontend.
- **Railway** o **Fly.io** para el BFF (sólo necesitamos demo durante evaluación).
- **GitHub Actions** para CI (lint + test).

### 3. Modelo de datos

#### 3.1 On-chain (Soroban storage)
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

#### 3.2 Off-chain (Postgres)
Las tablas espejean el on-chain + agregan capas analíticas. Ver `05-BACKEND-ESQUEMATICO.md` para SQL completo.

```
providers           → espejo de Soroban + datos enriquecidos
provider_metadata   → identidad, KYB, verificación
payments            → log enriquecido (precio, tx_hash, latencia)
trust_score_history → snapshots periódicos del score
ai_recommendations  → cache de respuestas LLM
```

### 4. Contratos de datos (Zod, `packages/contracts`)

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

### 5. APIs del BFF

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

### 6. Flujo crítico: pago x402-Stellar end-to-end

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

### 7. Trust Score: especificación

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

### 8. Seguridad

- **Private keys** sólo en `.env`, nunca commiteadas. `.env.example` documenta variables.
- **CORS**: BFF acepta sólo origins configurados.
- **Rate limiting** en `/api/recommend` (caro por uso de LLM): 30 req/min por IP.
- **Verificación de tx en x402**: siempre del lado del servidor consultando Horizon, nunca confiar en lo que envía el cliente.
- **Memo único** por challenge: previene replay attacks aunque mismo monto/destino.
- **Contrato Soroban**: `register_provider` exige `require_auth()` del owner; `log_payment` validado contra Token contract invocation.

### 9. Variables de entorno

```
## Stellar
STELLAR_NETWORK=testnet                # o "public"
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
USDC_ASSET_CODE=USDC
USDC_ASSET_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5  # testnet issuer
REGISTRY_CONTRACT_ID=C...              # output de soroban deploy

## Cuentas demo
DEMO_AGENT_SECRET=S...                 # nunca commitear
DEMO_PROVIDER_SECRET=S...

## BFF
BFF_PORT=4000
BFF_BASE_URL=http://localhost:4000
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://localhost/flovia
RECOMMEND_RATE_LIMIT_PER_MIN=30

## Frontend
NEXT_PUBLIC_BFF_URL=http://localhost:4000
```

### 10. Testing

- **Unit tests** en `packages/intelligence` (Trust Score determinístico).
- **Integration test** de middleware x402: levanta server fake, hace flujo completo en testnet.
- **Contract tests**: Soroban tests en Rust (`#[cfg(test)]`) con `soroban-sdk-testutils`.
- **Smoke test** del flujo demo: script `cli/scripts/demo.ts` que ejecuta el journey completo y reporta éxito/fallo. Se corre antes de cada presentación.

### 11. Observabilidad

Para el hackathon, mínimo viable:
- **Logs estructurados** (`pino`) en el BFF.
- **Página `/status`** que muestra: última conexión a Horizon, contract id, # providers cacheados.
- Sin métricas Prometheus por ahora (queda en roadmap).

### 12. Decisiones de diseño y trade-offs

| Decisión | Alternativa rechazada | Razón |
|---|---|---|
| USDC nativo como único activo | XLM, multi-asset | USDC es lo que un agente "entiende" como dinero estable. Multi-asset agrega complejidad sin valor demo. |
| Memo en challenge x402 | Sin memo, sólo amount+dest | El memo permite identificar el call específico → idempotencia limpia. |
| Registry on-chain (Soroban) | Registry off-chain (Postgres only) | El registry on-chain es lo que vuelve a Flovia "Stellar-native" y abre composabilidad. |
| Indexer pull-based en CLI | Push (webhooks) | Más simple para hackathon; webhooks de Horizon requieren más infra. |
| Trust Score determinístico | Modelo ML | Auditabilidad > sofisticación en POC. ML queda en roadmap. |


---

## Parte 3 — UI / UX


### 1. Principios de diseño

1. **Datos por encima de decoración.** Cada pantalla revela información on-chain real.
2. **Auditabilidad visible.** Cada número clave tiene su fuente clicable (link a Horizon, a contract, a explorer).
3. **Velocidad demo.** Cargas progresivas, esqueletos, nada de spinners eternos.
4. **Una sola intención por pantalla.** El usuario nunca se pregunta "¿y ahora qué hago?".

### 2. Sistema de diseño (propuesta inicial)

#### 2.1 Paleta
```
Primary:    #0A0F1E   (deep space — fondo principal)
Surface:    #131A2C   (cards)
Border:     #1F2940
Accent:     #4FFFB0   (Stellar-ish verde-cyan, para CTAs)
Accent-2:   #7B9CFF   (azul links/data)
Warning:    #FFB454
Danger:     #FF5C7A
Text:       #E8ECF8
Text-muted: #8993B0
```

#### 2.2 Tipografía
- **Display / titulares:** Inter Tight 600
- **Body:** Inter 400/500
- **Mono (addresses, hashes):** JetBrains Mono 500

#### 2.3 Espaciado
Escala 4px: `4, 8, 12, 16, 24, 32, 48, 64`.

#### 2.4 Componentes base (shadcn/ui)
- `Card`, `Badge`, `Button`, `Input`, `Tabs`, `Table`, `Tooltip`, `Sheet` (side drawer), `Skeleton`.
- Custom: `ScoreRing` (anillo radial 0-100), `AddressChip` (G... acortada con copy), `TxLink` (hash → explorer).

### 3. Mapa de pantallas

```
/                                Home / landing pública
/providers                       Catálogo
/providers/[id]                  Perfil 7-capas
/agents                          "Para desarrolladores" — docs del SDK + demo interactiva
/stats                           Métricas globales
/about                           Visión, equipo, roadmap (público SCF)
/playground                      Demo interactiva del agente (highlight para SCF)
```

### 4. Wireframes ASCII por pantalla

#### 4.1 Home (`/`)

```
┌────────────────────────────────────────────────────────────────────┐
│  Flovia                              Providers  Agents  Stats  ⓘ  │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│     Intelligence for the agentic payments economy on Stellar.     │
│                                                                    │
│     Discover, verify, and pay APIs autonomously — with on-chain   │
│     reputation built natively for Soroban.                        │
│                                                                    │
│     [  Open Catalog  ]   [  Try the Playground  ]                 │
│                                                                    │
│     ─────────────────────────────────────────────────────────     │
│                                                                    │
│     ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│     │   17     │  │  1,284   │  │  $4.2k   │  │   97%    │        │
│     │ providers│  │ payments │  │ volume   │  │ uptime   │        │
│     └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│                                                                    │
│     ─────────────────────────────────────────────────────────     │
│                                                                    │
│     ## The 7 layers                                                │
│     [ icons + one-liners ]                                         │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

#### 4.2 Catálogo (`/providers`)

```
┌────────────────────────────────────────────────────────────────────┐
│  Filters: [ Category ▼ ] [ KYB ✓ ] [ Min Score: 60 ] [ Search... ] │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ ●● FX Rates Oracle           USDC 0.005/call   Trust 87 ⬤   │ │
│  │     fx.example.com           KYB ✓   24h vol: $124           │ │
│  │     "Real-time FX for 80 corridors. Verified anchor."        │ │
│  └──────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ ●● Sentiment API              USDC 0.01/call    Trust 72 ⬤   │ │
│  │     sentiment.ai/agent       KYB pending   24h vol: $42      │ │
│  └──────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ ●● ... etc                                                   │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│                              [ Load more ]                         │
└────────────────────────────────────────────────────────────────────┘
```

#### 4.3 Perfil de proveedor (`/providers/[id]`) — **la pantalla estrella**

```
┌────────────────────────────────────────────────────────────────────┐
│  ← Back to catalog                                                 │
│                                                                    │
│  FX Rates Oracle                                       ╭───────╮   │
│  fx.example.com                                        │  87   │   │
│  GBFXP...ROVI (owner) [📋]   Contract: CFXR...[📋]    │ Trust │   │
│                                                        ╰───────╯   │
│                                                                    │
│  [ Discovery ] [ Identity ] [ Verify ] [ Finance ] [ Score ] [ AI ]│
│  ┌────────────────────────────────────────────────────────────┐    │
│  │                                                            │    │
│  │  TAB: Discovery (capa 1)                                   │    │
│  │  • Endpoint:    fx.example.com/v1/rate                     │    │
│  │  • Method:      GET                                        │    │
│  │  • Price:       0.005 USDC per call                        │    │
│  │  • Protocol:    x402-stellar-1                             │    │
│  │  • Last seen:   2 min ago [view on Horizon →]              │    │
│  │                                                            │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                    │
│  ─── How to consume from your agent ───                            │
│  ```ts                                                             │
│  import { Flovia } from '@flovia/agent-sdk';                       │
│  const f = new Flovia({ secret: process.env.AGENT_SECRET });       │
│  const data = await f.call('fx-rates-oracle', { pair: 'EUR/USD' });│
│  ```                                                               │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

#### 4.4 Tab "Score" (desglose Trust Score)

```
┌────────────────────────────────────────────────────────────────────┐
│  Trust Score 87 / 100                                              │
│                                                                    │
│  Age (15%)              ████████████████░░  84   (registered 76d)  │
│  Volume (30%)           ████████████░░░░░░  62   (log scale)       │
│  KYB (30%)              ████████████████████ 100  ✓ verified       │
│  Claims (15%)           ████████████████████ 100  0 disputes        │
│  Recency (10%)          ████████████████████ 100  active 3h ago    │
│                                                                    │
│  Formula: 0.15·84 + 0.30·62 + 0.30·100 + 0.15·100 + 0.10·100 = 87  │
│  [ View on-chain history → ]                                       │
└────────────────────────────────────────────────────────────────────┘
```

#### 4.5 Tab "AI" (recomendación)

```
┌────────────────────────────────────────────────────────────────────┐
│  AI Insight  (powered by Claude)                                   │
│                                                                    │
│  ▸ Strengths                                                       │
│    – Highest update frequency among FX providers in catalog.       │
│    – Verified KYB through Anchor X (SEP-12 tier 2).                │
│    – Zero disputed payments in 47 days of activity.                │
│                                                                    │
│  ▸ Watch outs                                                      │
│    – Volume still below $1k/day → score grows with usage.          │
│    – Single owner account → no fallback if compromised.            │
│                                                                    │
│  ▸ Best fit for                                                    │
│    Agents doing low-latency conversion checks before settlement.   │
│                                                                    │
│  [ Regenerate ]                                                    │
└────────────────────────────────────────────────────────────────────┘
```

#### 4.6 Playground (`/playground`) — **lo que va a venderlo a SCF**

```
┌────────────────────────────────────────────────────────────────────┐
│  Live agent demo                                                   │
│                                                                    │
│  Step 1 ─── Pose a need to the agent                               │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ "I need the EUR/USD rate, max $0.01, KYB required"          │ │
│  └──────────────────────────────────────────────────────────────┘ │
│  [ Run agent ]                                                     │
│                                                                    │
│  Step 2 ─── Flovia recommends                                      │
│  ✓ Picked: FX Rates Oracle  (Trust 87)                             │
│  Reasoning: best fit, KYB verified, price within budget.           │
│                                                                    │
│  Step 3 ─── Agent pays                                             │
│  • Built tx:    [hash...]                                          │
│  • Submitted:   ✓                                                  │
│  • Confirmed:   4.8s [view on Stellar Expert →]                    │
│                                                                    │
│  Step 4 ─── Provider serves data                                   │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ { "pair":"EUR/USD", "rate":1.0843, "ts":"..." }              │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  Total time end-to-end: 6.2s                                       │
└────────────────────────────────────────────────────────────────────┘
```

### 5. Estados y feedback

#### 5.1 Loading
- Skeletons en cards y tablas (no spinners).
- Para acciones del playground: stepper que avanza paso a paso.

#### 5.2 Empty states
- Catálogo vacío: "No providers yet. [Be the first to register →]"
- Sin pagos en historial: "This provider hasn't received payments yet."

#### 5.3 Errores
- Banner inline rojo con CTA accionable. Nunca modales de error.
- Para playground: el step que falló se marca, los siguientes quedan deshabilitados, hay botón [Retry].

#### 5.4 Confirmaciones positivas
- Toast con check verde, autodismiss 4s.

### 6. Responsive

- **Desktop (1280+):** layout completo de 2-3 columnas en perfil.
- **Tablet (768-1279):** tabs verticales pasan a horizontales con scroll.
- **Mobile (<768):** stack vertical. Playground en steps colapsables.

Para la demo asumimos desktop primario. Mobile es nice-to-have.

### 7. Accesibilidad mínima

- Contraste WCAG AA.
- `aria-label` en chips de address y botones icon-only.
- Navegación por teclado en tabs.
- `prefers-reduced-motion` respetado.

### 8. Componentes a construir (orden de prioridad)

1. `<ScoreRing value={87} />` — radial 0-100 con color según rango.
2. `<AddressChip account="G..." />` — short + copy + link a Stellar Expert.
3. `<TxLink hash="..." />` — hash corto + link.
4. `<ProviderCard provider={...} />` — para catálogo.
5. `<LayerTabs />` — tabs de las 7 capas en el perfil.
6. `<TrustScoreBreakdown score={...} />` — desglose con barras.
7. `<PlaygroundStepper />` — stepper animado del playground.
8. `<CodeBlock lang="ts" />` — para snippets del SDK.

### 9. Microcopy importante

| Contexto | Texto |
|---|---|
| CTA Home principal | "Open Catalog" |
| CTA Home secundario | "Try the Playground" |
| Empty catalog | "No providers yet. [Register the first →]" |
| Trust Score tooltip | "How is this calculated? [Open formula →]" |
| KYB pending badge | "Verification in progress" |
| Pago confirmado | "Settled on Stellar in 4.8s" |
| Error de pago | "Payment failed. [See on Horizon →]" |


---

## Parte 4 — Flujo de página


Este documento describe los **journeys completos** para los tres tipos de usuario, mapeando cada acción a la pantalla, al endpoint del BFF, y al efecto on-chain cuando aplique.

---

### 1. Journey: Visitante / Reviewer SCF (público)

**Objetivo:** entender qué es Flovia en menos de 90 segundos y ver una demo que funciona.

```
[ Landing / ]
     │
     │ Lee hero + métricas vivas
     ▼
[ Botón "Try the Playground" ]
     │
     ▼
[ /playground ]
     │
     │ Prompt pre-rellenado: "EUR/USD rate, KYB required"
     │ Click "Run agent"
     ▼
  Step 1: GET /api/recommend?need=fx&kyb_required=true
     │   ← BFF responde top-3 con reasoning
     ▼
  Step 2: UI muestra el provider elegido y la lógica
     │
     ▼
  Step 3: POST /api/pay/prepare → BFF arma XDR de la tx
     │   Backend firma con DEMO_AGENT_SECRET (en demo)
     │   Submit a Horizon
     ▼
  Step 4: Confirmación (~5s) → link a Stellar Expert
     │
     ▼
  Step 5: BFF llama al endpoint del provider con X-PAYMENT
     │
     ▼
  Resultado JSON renderizado in-place. Tiempo total medido.
     │
     ▼
[ CTA: "See the provider profile →" ]
     │
     ▼
[ /providers/[id] ] (capa por capa, con foco en Trust Score)
```

**Tiempo objetivo del journey completo:** ≤ 2 min.
**Métricas que dejan huella en el visitante:** "se settleó en 5 segundos", "el score lo calcula una fórmula que puedo auditar", "el contrato está deployado, acá tenés el link".

---

### 2. Journey: Desarrollador de agente

**Objetivo:** integrar Flovia en su agente en menos de 10 min.

```
[ /agents ] (página de docs)
     │
     │ Lee quickstart, copia snippet
     ▼
$ bun add @flovia/agent-sdk
     │
     ▼
  En su código:
     import { Flovia } from '@flovia/agent-sdk';
     const f = new Flovia({ secret: process.env.AGENT_SECRET });
     const result = await f.discoverAndCall({
       need: 'fx-rates',
       maxPrice: 0.01,
       kybRequired: true,
       payload: { pair: 'EUR/USD' }
     });
     │
     ▼
  SDK hace internamente:
     1. GET BFF_URL/api/recommend          → elige provider
     2. POST BFF_URL/api/pay/prepare       → recibe XDR
     3. Firma localmente con su seed
     4. submit a Horizon
     5. GET provider endpoint con X-PAYMENT
     6. Devuelve data al caller
     │
     ▼
[ Dashboard /agents/[address] ] (opcional)
     │ Ve historial de calls de su agente, costos, errores
```

**Endpoints usados:**
- `GET /api/recommend?need=...&maxPrice=...&kybRequired=...`
- `POST /api/pay/prepare` body: `{ providerId, callContext }`
- (cliente envía submit a Horizon directo)
- `POST /api/pay/verify` (opcional, para que Flovia indexe el pago)

---

### 3. Journey: Proveedor de API

**Objetivo:** registrarse, instalar middleware, recibir su primer pago.

```
[ /providers/new ] (formulario simple — opcional en hackathon)
     │
     │ Inputs:
     │   - Nombre
     │   - URL del endpoint
     │   - Precio en USDC
     │   - Stellar address de cobro (G...)
     │   - Categoría
     │
     │ El form muestra el código de la tx Soroban a firmar
     ▼
  Stellar wallet (Freighter / Albedo) firma `register_provider`
     │
     ▼
[ Contrato Soroban ]
     │ Emite evento `ProviderRegistered`
     │
     ▼
[ Indexer ] (apps/cli/indexer.ts)
     │ Polling cada N seg → detecta evento → inserta en Postgres
     │
     ▼
[ /providers/[id] ] aparece publicado
     │
     ▼
  Proveedor instala middleware en su servidor:
     │   import { x402Stellar } from '@flovia/x402-stellar';
     │   app.use('/api', x402Stellar({
     │     destination: 'G...',
     │     amountUsdc: '0.005',
     │     network: 'testnet'
     │   }));
     │
     ▼
  Primer agente lo consume → primer pago registrado en Horizon → Trust Score se actualiza.
```

---

### 4. Flujo de datos (pantallas ↔ servicios)

#### 4.1 Carga inicial del catálogo (`/providers`)

```
Browser ──GET /providers──► BFF ──SELECT * FROM providers──► Postgres
                            │
                            └──GET /providers?fresh=1──► Soroban RPC (refresh on-demand)
```

#### 4.2 Perfil de proveedor (`/providers/[id]`)

```
Browser ──GET /providers/:id/intelligence──► BFF
                                              │
                                              ├──► Postgres (provider + payments)
                                              ├──► Horizon (last activity, balances)
                                              ├──► Soroban RPC (contract state)
                                              ├──► intelligence/trust.ts → score
                                              └──► Anthropic Claude (insight) [cache 1h]
                                              │
                                              ▼
                                         payload 7-layer JSON
```

#### 4.3 Recomendación (`/api/recommend`)

```
Agente ──GET /api/recommend?need=X──► BFF
                                       │
                                       ├──► Postgres: filtra candidatos
                                       ├──► intelligence/ranker.ts: score combinado
                                       ├──► Claude: genera reasoning para top-3
                                       │
                                       ▼
                                  [ { providerId, score, reasoning }, ... ]
```

### 5. Estados globales del frontend

Manejados con **React Server Components** + cliente cuando hace falta interactividad. Sin Redux/Zustand para el hackathon.

| Estado | Dónde vive | Refresh |
|---|---|---|
| Listado de providers | RSC en `/providers/page.tsx` | revalidate 60s |
| Detalle provider | RSC en `/providers/[id]/page.tsx` | revalidate 30s |
| Stats globales | RSC en `/page.tsx` | revalidate 60s |
| Playground state | useState en cliente | n/a |
| AI insight | server-side cache | TTL 1h |

### 6. Error paths importantes

| Punto | Error posible | UX |
|---|---|---|
| `/api/recommend` | No hay providers que cumplan | UI: "No matches. Relax filters?" |
| `/api/pay/prepare` | Cuenta del agente sin fondos | UI: link al friendbot testnet + instrucciones |
| Submit a Horizon | Tx rechazada (memo dup, etc.) | UI: error específico + link al Horizon response |
| Provider endpoint | 5xx aunque pago OK | Refund automático? No — flag de incidente en Trust Score |
| Soroban RPC down | Indexer no actualiza | Banner global: "Live data delayed" |
| Claude API timeout | Insight no carga | Sección AI muestra "Unavailable, [retry]" — el resto sí carga |

### 7. Analytics mínimo (sin tracking invasivo)

Eventos a registrar en el BFF (no en el cliente) para reporte SCF:
- `recommend.requested` (con need category)
- `pay.prepared`, `pay.verified`, `pay.failed`
- `provider.registered`
- `playground.started`, `playground.completed`

Almacenar en tabla `events` con timestamp y payload JSON. Render en `/stats`.


---

## Parte 5 — Backend esquemático


### 1. Componentes del backend

```
apps/bff/                        Servidor HTTP (Bun + Hono)
apps/data/                       Migraciones Postgres + seeds
apps/cli/                        CLI scripts: indexer, seeds, demo
packages/sources/                Clientes a Horizon / Soroban / StellarExpert
packages/intelligence/           Lógica analítica (Trust Score, ranker, AI prompts)
packages/contracts/              Tipos Zod compartidos
code/x402-stellar-middleware/    Paquete publicable, usable por providers
```

### 2. Endpoints REST

#### 2.1 Catálogo

##### `GET /providers`
Lista de proveedores.

**Query params:**
- `category?` — `fx|data|ai|cdn|...`
- `kyb?` — `true|false|any` (default any)
- `minScore?` — number 0-100
- `q?` — búsqueda libre (nombre)
- `limit?` — default 25, max 100
- `cursor?` — para paginación

**Respuesta:**
```json
{
  "items": [
    {
      "id": "ctr_C123.../prov_42",
      "name": "FX Rates Oracle",
      "endpoint": "https://fx.example.com/rate",
      "priceUsdc": 0.005,
      "ownerAccount": "GBFXP...",
      "kybStatus": "verified",
      "trustScore": 87,
      "stats24h": { "calls": 248, "volumeUsdc": 1.24 }
    }
  ],
  "nextCursor": null
}
```

##### `GET /providers/:id`
Detalle ligero (sin AI insight ni history pesado).

##### `GET /providers/:id/intelligence`
Payload completo de 7 capas. **Endpoint estrella.**

```json
{
  "provider": { ...ProviderSchema },
  "identity": {
    "owner": "GBFXP...",
    "controlsContract": "C123...",
    "linkedDomains": ["fx.example.com"],
    "knownAliases": []
  },
  "verification": {
    "kybStatus": "verified",
    "kybProvider": "anchor:GANCH...",
    "kybTier": 2,
    "verifiedAt": "2026-05-13T..."
  },
  "finance": {
    "lifetimeVolumeUsdc": 124.55,
    "lifetimeCalls": 6212,
    "avgCallValue": 0.005,
    "balances": [ { "asset": "USDC", "balance": 42.11 } ],
    "topPathsIn": ["GBANCH...", "GBAGEN1..."]
  },
  "trustScore": {
    "total": 87,
    "components": {
      "age":     { "value": 84,  "weight": 0.15, "raw": "76 days" },
      "volume":  { "value": 62,  "weight": 0.30, "raw": "$124 USDC lifetime" },
      "kyb":     { "value": 100, "weight": 0.30, "raw": "verified tier 2" },
      "claims":  { "value": 100, "weight": 0.15, "raw": "0 disputes" },
      "recency": { "value": 100, "weight": 0.10, "raw": "active 3h ago" }
    },
    "computedAt": "2026-06-29T..."
  },
  "aiInsight": {
    "strengths": ["..."],
    "watchOuts": ["..."],
    "bestFitFor": "...",
    "model": "claude-sonnet-4-6",
    "cachedAt": "2026-06-29T..."
  }
}
```

#### 2.2 Recomendación

##### `GET /api/recommend`
**Query params:** `need`, `maxPrice`, `kybRequired`, `minScore`, `topN` (default 3).

**Respuesta:**
```json
{
  "query": { "need": "fx", "maxPrice": 0.01, "kybRequired": true },
  "results": [
    {
      "providerId": "...",
      "matchScore": 0.91,
      "reasoning": "Highest Trust Score among KYB-verified FX providers...",
      "estimatedCostUsdc": 0.005,
      "estimatedLatencyMs": 320
    },
    { "providerId": "...", "matchScore": 0.82, "reasoning": "..." }
  ],
  "generatedBy": "claude-sonnet-4-6",
  "cacheTtlSec": 60
}
```

#### 2.3 Pago

##### `POST /api/pay/prepare`
Construye XDR para que el agente firme.

**Request:**
```json
{ "providerId": "...", "callContext": { "endpoint": "/rate", "payload": "..." } }
```

**Respuesta:**
```json
{
  "xdrBase64": "AAAAAg...",
  "challenge": {
    "destination": "GBFXP...",
    "asset": { "code": "USDC", "issuer": "GBBD..." },
    "amount": "0.005",
    "memo": "f1c2e3...",
    "expiresAt": "2026-06-29T18:00:00Z"
  }
}
```

##### `POST /api/pay/verify`
Confirma que un pago se hizo (para indexar más rápido).

**Request:** `{ "txHash": "..." }`
**Respuesta:** `{ "verified": true, "providerId": "...", "amountUsdc": 0.005 }`

#### 2.4 Cuentas e introspección

##### `GET /accounts/:G/intelligence`
Perfil de cualquier cuenta Stellar (no sólo providers): balances, actividad, conexiones con providers conocidos. Útil para que el reviewer SCF pueda investigar.

#### 2.5 Stats

##### `GET /stats/overview`
Métricas globales: total providers, total payments, volumen acumulado, # agentes únicos.

#### 2.6 Salud

##### `GET /health`
`{ "ok": true, "horizon": "ok", "sorobanRpc": "ok", "db": "ok", "lastIndexedLedger": 12345678 }`

### 3. Esquema de base de datos (Postgres / Drizzle)

```sql
-- providers: espejo enriquecido del registry on-chain
CREATE TABLE providers (
  id              text PRIMARY KEY,           -- "contractId/providerId"
  contract_id     text NOT NULL,
  provider_id     bigint NOT NULL,
  name            text NOT NULL,
  endpoint        text NOT NULL,
  price_usdc      numeric(20,7) NOT NULL,
  owner_account   text NOT NULL,
  payment_asset   text NOT NULL DEFAULT 'USDC',
  category        text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL,
  last_seen_at    timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX providers_owner_idx ON providers(owner_account);
CREATE INDEX providers_category_idx ON providers(category);
CREATE INDEX providers_score_idx ON providers((metadata->>'trustScore') NULLS LAST);

-- verifications: KYB / KYC
CREATE TABLE verifications (
  provider_id   text REFERENCES providers(id),
  kyb_status    text NOT NULL,                -- 'verified' | 'pending' | 'none'
  kyb_provider  text,                          -- "anchor:G..."
  kyb_tier      smallint,
  verified_at   timestamptz,
  source        text,                          -- 'sep-12' | 'manual' | 'mock'
  PRIMARY KEY (provider_id)
);

-- payments: log de pagos detectados on-chain
CREATE TABLE payments (
  tx_hash         text PRIMARY KEY,
  provider_id     text REFERENCES providers(id),
  payer_account   text NOT NULL,
  amount_usdc     numeric(20,7) NOT NULL,
  memo            text,
  ledger          bigint NOT NULL,
  paid_at         timestamptz NOT NULL,
  served_ok       boolean,                    -- el provider sirvió el recurso?
  latency_ms      integer
);
CREATE INDEX payments_provider_idx ON payments(provider_id, paid_at DESC);
CREATE INDEX payments_payer_idx ON payments(payer_account, paid_at DESC);

-- trust_score_history
CREATE TABLE trust_score_history (
  provider_id   text REFERENCES providers(id),
  computed_at   timestamptz NOT NULL,
  total         smallint NOT NULL,
  components    jsonb NOT NULL,
  PRIMARY KEY (provider_id, computed_at)
);

-- ai_recommendations: cache de respuestas LLM
CREATE TABLE ai_recommendations (
  cache_key     text PRIMARY KEY,             -- hash de (provider_id + version)
  payload       jsonb NOT NULL,
  model         text NOT NULL,
  generated_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL
);

-- events: analítica del propio Flovia
CREATE TABLE events (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_type_idx ON events(type, occurred_at DESC);

-- indexer_state: cursor del indexer
CREATE TABLE indexer_state (
  key            text PRIMARY KEY,            -- 'last_ledger'
  value          text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

### 4. Jobs / procesos en background

#### 4.1 Indexer (`apps/cli/indexer.ts`)
- Corre cada 10 segundos.
- Pull de eventos Soroban desde `last_ledger`.
- Upsert en `providers` y `payments`.
- Recalcula `trustScore` para providers con actividad nueva.
- Inserta snapshot en `trust_score_history`.

#### 4.2 AI cache warmer (`apps/cli/ai-warmer.ts`)
- Corre cada hora.
- Para cada provider activo, regenera el insight si la cache expiró.

#### 4.3 Stats aggregator (`apps/cli/stats.ts`)
- Corre cada 5 min.
- Calcula stats globales y los cachea para `/stats/overview`.

### 5. Capa de fuentes (`packages/sources`)

```
packages/sources/
├── stellar/
│   ├── horizon.ts          # GET /accounts, /transactions, /payments
│   ├── soroban-rpc.ts      # invocations al contract, getEvents
│   ├── stellar-expert.ts   # perfil de cuenta enriquecido
│   └── usdc.ts             # constantes y helpers USDC en Stellar
├── kyb/
│   ├── sep12-anchor.ts     # stub que consulta un anchor
│   └── mock.ts             # tabla local para hackathon
└── transport.ts            # fetch con retry + timeout (se conserva)
```

Detalle de migración en `11-MIGRACION-PACKAGES-SOURCES.md`.

### 6. Capa de inteligencia (`packages/intelligence`)

```
packages/intelligence/
├── trust.ts               # cálculo de Trust Score (puro, testeable)
├── ranker.ts              # ranking para /api/recommend
├── ai.ts                  # llamada a Claude con prompts
└── prompts/
    ├── insight.ts         # prompt para perfil
    └── recommend.ts       # prompt para recomendación
```

#### 6.1 Trust score (signature)
```ts
export function computeTrustScore(input: {
  registeredAt: Date;
  volumeUsdc30d: number;
  kybStatus: 'verified' | 'pending' | 'none';
  kybTier?: number;
  disputes: number;
  totalPayments: number;
  lastActivityAt: Date | null;
}): TrustScoreResult; // { total, components }
```

#### 6.2 Ranker (signature)
```ts
export function rankProviders(
  candidates: ProviderWithIntelligence[],
  query: { need?: string; maxPrice?: number; kybRequired?: boolean; minScore?: number }
): RankedProvider[]; // sort by combined match score
```

### 7. Stellar SDK — patterns que repetimos

#### 7.1 Conexión
```ts
import { Horizon, SorobanRpc, Networks } from "@stellar/stellar-sdk";

export const horizon = new Horizon.Server(env.HORIZON_URL);
export const soroban = new SorobanRpc.Server(env.SOROBAN_RPC_URL);
export const networkPassphrase = env.STELLAR_NETWORK === 'public'
  ? Networks.PUBLIC : Networks.TESTNET;
```

#### 7.2 Verificar pago USDC
```ts
export async function verifyUsdcPayment(opts: {
  txHash: string;
  expectedDest: string;
  expectedAmount: string;
  expectedMemo: string;
}): Promise<{ ok: true } | { ok: false, reason: string }> {
  const tx = await horizon.transactions().transaction(opts.txHash).call();
  if (tx.memo !== opts.expectedMemo) return { ok: false, reason: 'memo mismatch' };
  const ops = await tx.operations();
  const payment = ops.records.find(o => o.type === 'payment');
  if (!payment) return { ok: false, reason: 'no payment op' };
  if (payment.to !== opts.expectedDest) return { ok: false, reason: 'destination mismatch' };
  if (payment.asset_code !== 'USDC') return { ok: false, reason: 'wrong asset' };
  if (Number(payment.amount) < Number(opts.expectedAmount)) return { ok: false, reason: 'underpayment' };
  return { ok: true };
}
```

#### 7.3 Invocar contract Soroban (read)
```ts
import { Contract, scValToNative, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";

export async function getProvider(contractId: string, providerId: bigint) {
  const contract = new Contract(contractId);
  const account = await soroban.getAccount(env.READER_ACCOUNT);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call("get_provider", /* args */))
    .setTimeout(30).build();
  const sim = await soroban.simulateTransaction(tx);
  return scValToNative(sim.result!.retval);
}
```

### 8. Pipeline LLM (recomendación e insight)

#### 8.1 Prompt skeleton para `/api/recommend`
```ts
const sys = `You are Flovia, an agentic-payments intelligence service on Stellar.
Given a need and a list of candidate providers (with Trust Score, KYB, price, recent activity),
pick the top N and explain succinctly why. JSON only.`;

const user = JSON.stringify({ query, candidates });

const res = await anthropic.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 800,
  system: sys,
  messages: [{ role: "user", content: user }],
});
```

#### 8.2 Estructura JSON forzada
Validamos la salida con Zod (`RecommendResponseSchema`). Si falla parsing, reintentamos con `temperature: 0`.

### 9. Despliegue local

```bash
## 1. Variables
cp .env.example .env
## Editar STELLAR_*, ANTHROPIC_API_KEY, DATABASE_URL

## 2. DB
docker compose up -d postgres
bun --filter=@flovia/data migrate
bun --filter=@flovia/data seed

## 3. Contrato (una vez)
cd code/soroban-registry
stellar contract build
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/flovia_registry.wasm \
  --network testnet --source <admin-secret>
## guardar el contract id en .env como REGISTRY_CONTRACT_ID

## 4. BFF + indexer + frontend
bun --filter=@flovia/bff dev      # puerto 4000
bun --filter=@flovia/cli indexer  # corre en otra terminal
bun --filter=@flovia/frontend dev # puerto 3000
```

### 10. Checklist de listo-para-demo

- [ ] Contrato deployado en testnet, ID en `.env`.
- [ ] 5+ providers seedeados con datos reales (no lorem ipsum).
- [ ] Indexer corriendo en background y al día.
- [ ] Playground hace el end-to-end en < 10s sin errores.
- [ ] `/health` devuelve todo `ok`.
- [ ] Variables sensibles NO en repo (review pre-push).
- [ ] Video grabado como fallback.


---

## Parte 6 — Plan de implementación


> Cada día tiene **una meta clara**, **tickets accionables**, y un **criterio de "listo"**. Si un día no se cumple, se sacrifica scope, no calidad.

---

### Día 0 (medio día, opcional) — Preparación

- [ ] **0.1** Crear repo limpio o branch `stellar-migration` sobre el fork actual.
- [ ] **0.2** Abrir el repo en Claude Code, importar todos los `.md` de este paquete en la raíz como `/docs/`.
- [ ] **0.3** Crear `.env.example` con las variables de TRD § 9.
- [ ] **0.4** Instalar `stellar-cli` localmente: `curl -L https://stellar-cli.installer.run | sh`
- [ ] **0.5** Crear cuentas testnet con friendbot, anotarlas en un `accounts.local.md` (gitignored).

**Listo cuando:** podés correr `stellar account fund <G>` y ves el balance en `horizon-testnet.stellar.org/accounts/<G>`.

---

### Día 1 — Fundación Stellar (capa `sources`)

**Meta:** reemplazar toda la capa `packages/sources` por la versión Stellar y tener funciones que devuelvan datos reales de testnet.

#### Tickets
- [ ] **1.1** Borrar `packages/sources/{x402-discovery.ts,cdp-discovery.ts,bitquery.ts,zerion.ts,mpp-registry.ts}`. Conservar `transport.ts`.
- [ ] **1.2** Crear `packages/sources/stellar/horizon.ts` con: `getAccount(G)`, `listPayments(G, limit)`, `getTransaction(hash)`. Ver `11-MIGRACION-PACKAGES-SOURCES.md`.
- [ ] **1.3** Crear `packages/sources/stellar/soroban-rpc.ts` con: `simulate(contractId, fn, args)`, `getEvents(fromLedger)`.
- [ ] **1.4** Crear `packages/sources/stellar/usdc.ts` con constantes del asset (issuer testnet) y helpers.
- [ ] **1.5** Crear `packages/sources/stellar/stellar-expert.ts` (opcional, fallback a Horizon).
- [ ] **1.6** Test manual: script CLI que consulta una cuenta de prueba y printea sus pagos USDC.

**Listo cuando:** `bun run apps/cli/test-stellar.ts <G>` imprime balances + 5 últimos pagos. Sin errores.

---

### Día 2 — x402 sobre Stellar (el diferenciador #1)

**Meta:** middleware funcional + servidor demo protegido + cliente que paga.

#### Tickets
- [ ] **2.1** Implementar `code/x402-stellar-middleware/src/server.ts` (skeleton ya provisto en este paquete) y publicarlo como paquete interno del monorepo `@flovia/x402-stellar`.
- [ ] **2.2** Implementar `code/x402-stellar-middleware/src/verify.ts` con `verifyUsdcPayment` (de TRD § 7.2).
- [ ] **2.3** Implementar `code/x402-stellar-middleware/src/client.ts` para el lado agente.
- [ ] **2.4** Crear `apps/demo-provider/index.ts` — servidor Hono con UN endpoint `/rate` protegido por el middleware.
- [ ] **2.5** Crear `apps/cli/scripts/demo-call.ts` que ejecuta el flujo: GET sin pago → 402 → pago → GET con `X-PAYMENT` → recibe data.
- [ ] **2.6** Edge cases: pago duplicado, memo inválido, underpayment. Cada uno con test.

**Listo cuando:** `bun apps/cli/scripts/demo-call.ts` completa el ciclo en <10s con la primera tx pagada de verdad en testnet (ver en Stellar Expert).

---

### Día 3 — Contrato Soroban + indexer

**Meta:** registry on-chain + indexer que lo refleja en Postgres.

#### Tickets
- [ ] **3.1** Tomar el contrato `code/soroban-registry/src/lib.rs` (skeleton provisto), revisarlo y `stellar contract build`.
- [ ] **3.2** `stellar contract deploy` a testnet, guardar contract ID en `.env`.
- [ ] **3.3** Llamar `register_provider` 5 veces con datos demo realistas (script en `apps/cli/scripts/seed-providers.ts`).
- [ ] **3.4** Implementar `apps/cli/indexer.ts`:
  - Lee `last_ledger` de `indexer_state`.
  - Llama `soroban-rpc.getEvents` con ese cursor.
  - Para evento `provider_registered`: upsert en `providers`.
  - Para evento `payment_logged`: upsert en `payments`.
  - Actualiza `last_ledger`.
- [ ] **3.5** Tests Rust del contrato (`cargo test`).
- [ ] **3.6** Conectar middleware x402 al contrato: cada pago verificado opcionalmente llama `log_payment`.

**Listo cuando:** el indexer corriendo levanta los 5 providers + sus pagos del día 2, sin duplicados, con `last_ledger` avanzando.

---

### Día 4 — Inteligencia + Trust Score + IA

**Meta:** `packages/intelligence` completo + endpoints `/providers/:id/intelligence` y `/api/recommend`.

#### Tickets
- [ ] **4.1** Implementar `packages/intelligence/trust.ts` con la fórmula de TRD § 7. Tests unitarios con casos borde.
- [ ] **4.2** Implementar `packages/intelligence/ranker.ts`.
- [ ] **4.3** Implementar `packages/intelligence/ai.ts` con cliente Anthropic + Zod parsing de la respuesta.
- [ ] **4.4** Construir `apps/bff/routes/providers.ts` con `GET /providers`, `GET /providers/:id`, `GET /providers/:id/intelligence`.
- [ ] **4.5** Construir `apps/bff/routes/recommend.ts` con `GET /api/recommend`.
- [ ] **4.6** Cache de AI con tabla `ai_recommendations` (TTL 1h).
- [ ] **4.7** Mock KYB en `packages/sources/kyb/mock.ts`: tabla local con 3 providers verified, 1 pending, 1 none.
- [ ] **4.8** Endpoint `/health` con checks de Horizon, Soroban RPC, DB.

**Listo cuando:** `curl /providers/<id>/intelligence` devuelve un JSON completo con las 7 capas, incluyendo Trust Score correcto y reasoning de Claude.

---

### Día 5 — Frontend + Playground + SDK del agente

**Meta:** dashboard navegable + playground funcional + SDK publicable.

#### Tickets
- [ ] **5.1** Setup Next.js 14 si no está; instalar shadcn/ui, tailwind.
- [ ] **5.2** Componentes base: `ScoreRing`, `AddressChip`, `TxLink`, `ProviderCard`, `LayerTabs`, `TrustScoreBreakdown`.
- [ ] **5.3** Página `/` con hero + stats vivos.
- [ ] **5.4** Página `/providers` (catálogo) con filtros.
- [ ] **5.5** Página `/providers/[id]` con tabs de las 7 capas.
- [ ] **5.6** Página `/playground` con stepper end-to-end. **Ésta es la página que va a vender el proyecto.**
- [ ] **5.7** Página `/stats` con métricas globales.
- [ ] **5.8** SDK `@flovia/agent-sdk` (`code/agent-sdk/`): clase `Flovia` con `discoverAndCall`, `recommend`, `pay`.
- [ ] **5.9** Página `/agents` con docs del SDK + snippet copiable.

**Listo cuando:** el playground se puede correr 5 veces seguidas sin errores y cualquier reviewer puede entender qué pasó en cada paso.

---

### Día 6 — Pulido, deploy, materiales SCF

**Meta:** todo deployado, video grabado, aplicación SCF enviada.

#### Tickets
- [ ] **6.1** Deploy frontend a Vercel.
- [ ] **6.2** Deploy BFF + indexer a Railway/Fly.io. Variables de entorno cargadas.
- [ ] **6.3** Verificar `/health` en producción.
- [ ] **6.4** Grabar video de 3 min:
  - 30s: el problema (pagos agénticos sin inteligencia)
  - 60s: tour por el dashboard (catálogo → perfil → score)
  - 60s: playground en vivo (recomendar → pagar → consumir)
  - 30s: visión 7 capas + cierre
- [ ] **6.5** README del repo principal con: setup, demo, screenshots, links a docs.
- [ ] **6.6** Pulir `08-PITCH-DECK.md` y `10-SCF-PITCH-7-CAPAS.md` con números reales.
- [ ] **6.7** Aplicar a SCF: completar formulario, adjuntar video, link al repo y al demo.
- [ ] **6.8** Smoke test final: ejecutar `apps/cli/scripts/demo.ts` 3 veces, todas exitosas.

**Listo cuando:** la aplicación a SCF está enviada y el demo público funciona desde un device limpio.

---

### Día 7 — Buffer

Sin tickets fijos. Reservado para:
- Bugs detectados durante el día 6.
- Mejorar el video si el primer corte no convence.
- Agregar 1 feature "wow" si quedó tiempo (sugerencia: integración real con un anchor testnet, o un segundo provider category).
- Descansar antes de la presentación.

---

### Reglas no negociables

1. **Test antes de demo.** Cada vez que se va a mostrar el playground, correr el smoke test primero.
2. **No mainnet esta semana.** Testnet es suficiente y más seguro.
3. **Nada se mergea sin lint pasando.**
4. **Si algo está mockeado, el código lo dice explícitamente** (`// MOCK_KYB:` comment + log en runtime).
5. **El video pesa más que cualquier código.** Si hay que elegir entre pulir un componente o re-grabar el video, gana el video.

### Gestión de scope en caliente

Si al día 4 vas atrasado, sacrificás en este orden:
1. **Primero:** página `/stats` (es nice-to-have).
2. **Segundo:** SDK `@flovia/agent-sdk` (el playground puede llamar al BFF directo).
3. **Tercero:** AI insight en el perfil (el ranker sí queda).
4. **Cuarto (si todo se cae):** registro de proveedor desde UI — los seedeás vía CLI.

Lo que **nunca** se sacrifica: playground, contrato Soroban deployado, middleware x402 real, Trust Score con desglose.


---

## Parte 7 — Business Plan


### 1. Resumen ejecutivo

Flovia es la **capa de inteligencia y reputación para la economía de pagos agénticos** sobre Stellar. Resolvemos el problema de "cómo un agente autónomo elige y paga al mejor proveedor de servicios" en una red donde el pago es trivial pero la decisión informada todavía no.

Nuestro modelo combina **infraestructura abierta** (protocolo x402-Stellar, contrato Soroban) con **servicios premium** (API de recomendación, scoring avanzado, verificaciones KYB). En el corto plazo nos posicionamos como infraestructura crítica del ecosistema Stellar para pagos máquina-a-máquina; en el mediano plazo, somos el "Bloomberg + Moody's" de la economía agéntica.

### 2. Problema y oportunidad

#### 2.1 La nueva economía de pagos
Tres tendencias se cruzan en 2025-2026:
1. **LLMs con capacidad de ejecutar acciones** (function calling, tool use, MCP, Computer Use).
2. **Infraestructura cripto que vuelve los pagos online sub-segundo y casi gratis** (USDC en redes de alta performance como Stellar).
3. **Aparición de APIs especializadas pequeñas** que se monetizan por uso, no por suscripción.

El resultado: agentes que necesitan **descubrir, evaluar y pagar** decenas de APIs distintas, automáticamente. Hoy, ningún producto cubre eso de punta a punta en ninguna cadena, y mucho menos en Stellar.

#### 2.2 Tamaño del mercado (estimación)

| Capa de mercado | Tamaño | Plazo |
|---|---|---|
| **TAM** — Pagos B2B globales | $200T anual | 2030 |
| **SAM** — Pagos programáticos / API | $50B anual estimado | 2027 |
| **SOM (Stellar)** — Pagos agénticos sobre Stellar | $50-200M anual estimado | 2026-2027 |

Estimaciones propias basadas en el crecimiento de USDC en Stellar (Circle reporta volúmenes mensuales crecientes), la adopción de MCP entre desarrolladores, y comparables como Stripe (cobra ~3% sobre $1T procesados → $30B revenue).

### 3. Producto

(Ver detalle en `01-PRD.md`)

**Hoy (hackathon):** plataforma con catálogo, perfil 7 capas, motor de recomendación, middleware x402, contrato Soroban, SDK para agentes.

**12 meses:** mainnet, anchors integrados realmente, KYB tier 2-3 real, marketplace de providers con miles de APIs, embeddings para discovery semántico, modelo Trust Score basado en ML.

**24 meses:** dispute resolution on-chain, insurance pool para pagos fallidos, agentes federados firmando reputación mutua, integraciones con wallets agénticas.

### 4. Modelo de negocio

#### 4.1 Capas de monetización

| Capa | Producto | Cliente | Precio |
|---|---|---|---|
| **Infra abierta** | Middleware x402, contrato Soroban, catálogo público | Providers, todos | Gratis (open source) |
| **Listing premium** | Verificación KYB acelerada, badge destacado | Providers | $50-500/mes (recurrente) |
| **API Pro** | `/api/recommend` sin rate limit, scoring extendido, SLA | Builders de agentes | Pay-per-call (USDC nativo): $0.001-0.01/req |
| **Intelligence Enterprise** | Insights agregados de mercado, alertas de fraude, exportación de datos | Anchors, exchanges, fondos | $2k-20k/mes |
| **Disputes & Insurance** (24m) | Resolución de disputas + pool de seguros | Providers + agentes | 0.5% sobre volumen asegurado |

#### 4.2 Unit economics (proyección año 1, mainnet)

| Métrica | Valor base | Notas |
|---|---|---|
| Providers activos | 500 | 50 premium ($200/m promedio) → $10k MRR |
| Agentes consumiendo API Pro | 2,000 | 1M requests/mes × $0.003 = $3k MRR |
| Enterprise contracts | 5 | $8k promedio → $40k MRR |
| **MRR total año 1** | **$53k** | ARR ~ $640k |
| Costos infra + LLM | $4k/mes | escala con uso |
| Costo equipo (3 personas) | $25k/mes | dev + diseño + comercial |
| **Burn neto año 1** | ~$0 (ya breakeven a los 12 meses) | depende de crecimiento |

#### 4.3 Por qué Stellar es el lugar correcto para construir esto
- **USDC nativo y de Circle directo** → confianza institucional.
- **Fees ~0** → micropagos viables ($0.001/call no se come por gas).
- **Finalidad 5 segundos** → UX agéntica fluida.
- **Anchors regulados** → único ecosistema cripto con KYB nativo de stack.
- **SCF activo** → financiamiento y comunidad para builders.
- **Soroban joven pero estable** → menos competencia, más diferenciación.

### 5. Go-to-market

#### 5.1 Fase 0 (hackathon SCF, mes 0)
- Demo público funcional.
- 5 providers seedeados.
- Aplicación SCF para grant Build (típicamente $15k-50k).
- Comunidad: post de lanzamiento en X / Stellar Discord / dev.to.

#### 5.2 Fase 1 (meses 1-3) — Tracción técnica
- Migrar a mainnet con 20 providers reales.
- Integrar 1-2 anchors verdaderos (Stellar Anchor Directory).
- Publicar SDK en npm.
- Lograr 10 builders externos usando la API.
- KPI: 100k requests procesadas, 50 wallets de agentes únicas.

#### 5.3 Fase 2 (meses 4-9) — Producto comercial
- Lanzar tier Premium para providers.
- Lanzar tier API Pro con pagos USDC en mainnet.
- Conseguir 3 clientes Enterprise (anchors, fintechs, wallets).
- Hire: 1 developer fullstack, 1 BD.
- KPI: $20k MRR.

#### 5.4 Fase 3 (meses 10-18) — Expansión
- Verificaciones tier 3 (institucional).
- Disputes & insurance pool.
- Conferencias: Meridian, ETHGlobal stops.
- Levantar pre-seed / seed ($1-3M).
- KPI: $100k MRR.

### 6. Competencia

| Competidor | Cadena | Qué hace | Por qué no compite directo |
|---|---|---|---|
| **Coinbase x402** | Multi (EVM) | Protocolo x402 spec | Es el protocolo, no la inteligencia. Podemos ser amigos. |
| **HitPay MPP** | Multi | Machine Payments Protocol | Distinto enfoque (B2B billing). No Stellar nativo. |
| **Bitquery / Dune** | Multi | Indexing on-chain | Datos crudos. No verticalizado a agentes. |
| **Soroswap, otros DEX en Stellar** | Stellar | Trading | Producto distinto, no overlapping. |
| **Chainalysis** | Multi | Compliance / KYB | Enterprise tradicional, no agent-centric. |
| **Nadie** | **Stellar** | **Agent intelligence + payments** | **Nuestro hueco.** |

### 7. Equipo

(Sección para llenar con datos reales del solicitante. Sugerencia para SCF:)

- **Founder técnico:** DonCervantes — experiencia previa en POC de inteligencia de pagos agénticos (repo público), background X.
- **Asesores potenciales:** sumar 1-2 advisors del ecosistema Stellar (devs experimentados en Soroban, o gente de un anchor).
- **Roadmap de hires:** mes 4 — fullstack senior; mes 8 — BD/partnerships; mes 12 — designer.

### 8. Pedido SCF

#### 8.1 Programa apuntado
**SCF Build** — para proyectos con demo funcional buscando construir a producción.

#### 8.2 Monto solicitado (orientativo)
**$25,000 USD en XLM**, distribuidos en milestones:

| Milestone | Entregable | % del grant |
|---|---|---|
| M1 (mes 1) | Mainnet deploy con 10 providers reales y 1 anchor integrado | 25% |
| M2 (mes 3) | SDK publicado + 5 builders externos integrados | 25% |
| M3 (mes 6) | API Pro con 100k requests procesadas, $5k MRR | 25% |
| M4 (mes 9) | Modelo Trust Score 2.0 + dispute resolution v1 | 25% |

#### 8.3 Uso de fondos
- 60% desarrollo (contractors específicos: auditor Soroban, designer)
- 20% infra y servicios (Anthropic, hosting, audits)
- 15% community / contenido (docs, tutoriales, video series)
- 5% legal (entidad, tos)

### 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Adopción lenta de pagos agénticos | Cabeza de playa: integrar primero con builders existentes que YA pagan por APIs (no esperar a que el mundo cambie). |
| x402 no se estandariza | Implementación es agnóstica; podemos pivotar a otro estándar con el mismo backend. |
| Competencia de Coinbase / big players | Nuestra ventaja es ser Stellar-nativo + reputación + KYB. Si entra Coinbase, los integramos. |
| Regulación | Sólo procesamos USDC (Circle), no custodiamos. Trabajamos con anchors regulados. |
| Equipo solo | SCF + advisors + comunidad Stellar. Open source acelera contribuciones. |

### 10. Métricas clave (north stars)

- **Volumen USDC procesado vía x402-Stellar** (mensual)
- **N° de agentes únicos** que consumen la API
- **% de providers con KYB verified**
- **Trust Score promedio del catálogo** (calidad del marketplace)
- **MRR** (sustentabilidad)

### 11. Visión a 5 años

Flovia es el estándar de hecho para que **cualquier agente autónomo opere económicamente** en internet. Cuando un LLM en 2030 necesite pagar por algo, la pregunta no será "¿cómo pago?" sino "¿qué provider de Flovia uso?" — del mismo modo que hoy un humano no se pregunta cómo enviar un email, se pregunta a quién escribir.

Stellar se vuelve, gracias a Flovia y a la primitiva USDC, **la red de settlement por defecto para la economía agéntica global**.


---

## Parte 8 — Pitch Deck


> Formato: 10 slides. Cada `---` es un slide. Diseñado para 3 min de pitch o 5 min con Q&A.

---

### Slide 1 — Cover

## Flovia
#### Intelligence for the agentic payments economy on Stellar

**Hackathon SCF — 2026**
By DonCervantes · github.com/DonCervantes/flovia-stellar

---

### Slide 2 — The shift

## Pagos están dejando de ser humanos.

- LLMs ejecutan acciones (function calling, MCP, Computer Use)
- Agentes consumen APIs y pagan por uso
- Stellar tiene la mejor primitiva de pago: **USDC nativo, $0 fees, finalidad 5s**

**Pero los agentes están ciegos.** No saben a quién pagarle, ni si es confiable.

---

### Slide 3 — The problem

## Un agente que paga en Stellar hoy no puede responder:

1. ¿Qué APIs existen para mi necesidad?
2. ¿Cuál es el precio justo?
3. ¿Esta cuenta destino es real? ¿Tiene KYB?
4. ¿Cumplió antes? ¿Tiene reputación?
5. ¿Cuál elijo entre 5 opciones equivalentes?

**Resultado:** ningún builder serio va a delegar dinero a un agente todavía.

---

### Slide 4 — The solution

## Flovia: 7 capas de inteligencia agéntica

| # | Capa |
|---|---|
| 1 | **Descubrimiento** — catálogo de APIs con pago x402 sobre Stellar |
| 2 | **Identidad** — quién está detrás de cada cuenta y contrato |
| 3 | **Verificación** — KYB/KYC vía anchors Stellar (SEP-12) |
| 4 | **Inteligencia financiera** — volumen, paths, FX, costos |
| 5 | **Reputación** — Trust Score on-chain, transparente |
| 6 | **IA** — recomendaciones accionables (Claude) |
| 7 | **Infra para agentes** — API + SDK: agentes consultan y deciden |

---

### Slide 5 — How it works (live demo)

```
Agente:  "EUR/USD rate, max $0.01, KYB required"
            ↓ 1
Flovia:  Top-3 providers + reasoning
            ↓ 2
Agente:  Paga 0.005 USDC vía x402-Stellar (5s ⛓)
            ↓ 3
Provider: Sirve la data
            ↓
[ tiempo end-to-end: 6.2 s ]
```

> Demo en vivo en flovia.app/playground

---

### Slide 6 — Why Stellar

| | Stellar | Otros |
|---|---|---|
| USDC nativo | ✅ Circle directo | Bridges, wrappers |
| Fees | ~$0.00001 | $0.001 - $5 |
| Finalidad | 5 s | 10s - 12min |
| KYB nativo (anchors) | ✅ regulados | ❌ |
| Soroban (smart contracts) | ✅ joven y limpio | Saturados |
| SCF + comunidad | ✅ enfocada | dispersa |

**Stellar es la única red diseñada para pagos reales.** Flovia es la inteligencia que le faltaba.

---

### Slide 7 — Traction (semana hackathon)

- ✅ Middleware x402-Stellar funcionando en testnet
- ✅ Contrato Soroban deployado: `C...`
- ✅ 5 providers reales registrados
- ✅ Dashboard + playground públicos
- ✅ SDK `@flovia/agent-sdk` publicado
- ✅ Demo end-to-end: < 7 segundos

Repo: github.com/DonCervantes/flovia-stellar (MIT)
Demo: flovia.app

---

### Slide 8 — Business model

| Capa | Quién paga | Cómo |
|---|---|---|
| Infra abierta | Nadie | Open source |
| Listing premium | Providers | $50-500/mes |
| API Pro | Builders de agentes | $0.001-0.01/req |
| Intelligence Enterprise | Anchors, exchanges | $2k-20k/mes |
| Insurance pool (24m) | Volumen asegurado | 0.5% |

**Año 1 target:** $50k MRR — breakeven con equipo de 3.

---

### Slide 9 — Ask & roadmap

#### Pedido SCF: **$25k en XLM**

| Mes | Milestone |
|---|---|
| 1 | Mainnet + 10 providers + 1 anchor real |
| 3 | SDK publicado, 5 builders integrados |
| 6 | API Pro, 100k requests, $5k MRR |
| 9 | Trust Score 2.0 + dispute resolution |

#### Por qué ahora
Los agentes con capacidad de pago están explotando. Quien construya la capa de inteligencia se vuelve infraestructura crítica antes que aparezcan competidores.

---

### Slide 10 — Closing

## La economía agéntica necesita Stellar.
## Stellar necesita Flovia.

**Demo:** flovia.app/playground
**Repo:** github.com/DonCervantes/flovia-stellar
**Contacto:** [email]

*Thank you.*

---

### Notas para el presentador

- **Tono:** confiado, no salesy. Cada claim respaldado con código o link.
- **Demo:** correr el playground EN VIVO. Tener un fallback en video por si testnet falla.
- **Cierre fuerte:** la última frase tiene que dejar al reviewer pensando.
- **Q&A esperado:**
  - ¿Por qué Stellar y no Solana / Base? → Slide 6. USDC nativo + anchors regulados.
  - ¿Cómo monetizan a corto plazo? → Slide 8, premium listing es cobrable desde mes 2.
  - ¿Y si Coinbase saca su propio x402 con scoring? → ellos resuelven el protocolo, nosotros la inteligencia + KYB nativo de Stellar.
  - ¿Cómo se calcula Trust Score? → fórmula transparente, ver `/providers/[id]` tab Score.
  - ¿Qué pasa si un provider miente sobre lo que sirve? → flag de incidente → impacto en Trust Score → roadmap con disputes.


---

## Parte 9 — White Paper


**Version:** 0.1 (Draft, Hackathon SCF)
**Date:** 2026
**Author:** DonCervantes

---

### Abstract

We introduce **Flovia**, an intelligence and reputation layer for the agentic payments economy built natively on the Stellar network. Flovia addresses a gap that emerges with the convergence of three trends: autonomous AI agents capable of executing actions, low-cost programmable stablecoin payments (USDC on Stellar), and the rise of pay-per-use specialized APIs. While Stellar provides the ideal payment primitive for machine-to-machine commerce, no existing system enables agents to **discover, evaluate, and select** providers in a way that is verifiable, transparent, and composable. Flovia closes this gap with seven integrated layers: payment discovery, identity, KYB verification, financial intelligence, on-chain reputation (Trust Score), AI-driven recommendations, and an agent-facing API.

This paper outlines the protocol design (including an HTTP 402 "x402-Stellar" variant), the on-chain registry powered by Soroban smart contracts, the Trust Score formula, and the architecture of the intelligence and recommendation engine.

---

### 1. Introduction

#### 1.1 The Emergence of Agentic Payments

Until recently, payments on the internet have been an essentially human-mediated activity. Even when automated (subscriptions, recurring transfers), a human authorized the relationship up front. Three developments are now changing this:

1. **Capable autonomous agents.** Large Language Models (LLMs) with structured tool use (function calling, the Model Context Protocol [MCP], Computer Use APIs) can plan and execute multi-step tasks involving external services. These agents increasingly need to pay for the services they consume.
2. **Programmable, low-cost stablecoins.** USDC on Stellar offers ~$0.00001 transaction fees and 5-second finality. This makes micropayments (sub-cent) economically viable for the first time.
3. **API-shaped services.** A growing portion of useful internet capability is delivered through narrow, specialized APIs (real-time FX, sentiment analysis, embeddings, geo lookups, etc.). These services lend themselves to pay-per-call rather than subscription billing.

The intersection of these three is the **agentic payments economy**: machines paying machines, in stablecoins, at scale, with little or no human intervention per transaction.

#### 1.2 The Trust Gap

The payment primitive — moving USDC from agent to provider on Stellar — is solved. What is not solved is the **decision** that precedes the payment:

- Which providers exist for a given need?
- What is the right price?
- Is the destination account legitimate? Has it undergone KYB?
- Has the provider performed reliably in the past?
- Among candidates, which is the best fit for this specific agent's policy (budget, latency, compliance)?

Today, an autonomous agent on Stellar has no native way to answer these. The information exists in fragments — across Horizon's transaction history, anchor directories, Soroban contract state, public domain registries — but no system aggregates and interprets them into a single decision-grade signal.

#### 1.3 Contribution

Flovia provides this missing layer. The contributions of this paper are:

1. A specification for **x402-Stellar**, a variant of the HTTP 402 ("Payment Required") protocol that uses Stellar payments as settlement.
2. A **Soroban smart contract** that serves as the on-chain registry of providers and as a tamper-evident log of payments, enabling composable reputation.
3. A transparent, deterministic **Trust Score** formula based on observable on-chain and verifiable off-chain inputs.
4. An **agent-facing API and SDK** that exposes discovery, recommendation, and payment execution in one cohesive interface.

---

### 2. The x402-Stellar Protocol

#### 2.1 Background

HTTP 402 ("Payment Required") has existed in the HTTP specification since the original RFC but has been reserved without standardized semantics. Recent proposals (notably from Coinbase) have revived it as the vehicle for crypto-settled per-request payments on the web. x402 is **settlement-layer agnostic**: it defines a challenge-response protocol, while the actual payment can be settled on any chain. We define here the Stellar-specific binding.

#### 2.2 Challenge

A protected resource responds to an unpaid request with HTTP 402 and a JSON challenge:

```json
{
  "version": "x402-stellar-1",
  "network": "testnet" | "public",
  "asset": { "code": "USDC", "issuer": "<G...>" },
  "amount": "0.005",
  "destination": "<G...>",
  "memo": "<unique challenge id>",
  "expires_at": "<ISO-8601>"
}
```

The `memo` field is critical: it ensures that each challenge is uniquely identifiable, enabling idempotency and preventing replay.

#### 2.3 Response

The client (agent) constructs a Stellar `Payment` operation matching the challenge, signs it with its source account, and submits it to Horizon. Upon confirmation (~5 seconds), the client retries the original request with header:

```
X-PAYMENT: <transaction hash>
```

#### 2.4 Verification

The protected resource's middleware:
1. Fetches the transaction from Horizon by hash.
2. Verifies: `memo` matches challenge, destination matches, asset matches (USDC + issuer), amount ≥ challenge amount, transaction `successful: true`.
3. Checks that the transaction hash has not been consumed for any prior challenge (replay protection).
4. Optionally invokes the `log_payment` function on the Flovia Soroban registry to record the payment on-chain.
5. Serves the resource.

#### 2.5 Design choices

- **Memo-based idempotency.** Stellar transactions natively carry a memo field, which we co-opt as the challenge identifier. This means the verification can be done purely from on-chain data, with no external state coordination.
- **USDC only (v1).** Restricting to a single asset eliminates ambiguity for agents and reflects the practical reality of agentic transactions, where stablecoin denomination is desired.
- **Strict by default.** Overpayment is accepted; underpayment is rejected. Behavior is configurable per provider.

---

### 3. The Soroban Registry Contract

#### 3.1 Purpose

The registry serves three goals:
1. Provide a canonical, on-chain source of truth for "which providers exist."
2. Tie each provider to a Stellar account that controls it, enabling identity attestations.
3. Optionally log payments to provide an immutable activity record beyond what Horizon offers.

#### 3.2 Storage

```rust
struct Provider {
  owner: Address,
  name: String,
  endpoint: String,
  price_stroops: u64,
  payment_token: Address,
  metadata_hash: BytesN<32>,
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

#### 3.3 Functions

| Function | Auth | Effect |
|---|---|---|
| `register_provider(owner, name, endpoint, price, token, metadata_hash)` | `owner.require_auth()` | Inserts a new provider, emits `provider_registered` event |
| `update_provider(id, ...)` | owner of provider | Updates mutable fields |
| `deactivate(id)` | owner of provider | Sets `active = false` |
| `log_payment(provider_id, payer, amount, tx_hash)` | open (anyone can attest) | Inserts a `PaymentLog` if not duplicate, emits `payment_logged` |
| `get_provider(id)` | read | Returns provider |
| `list_providers()` | read | Returns list of providers (max page size 100) |

#### 3.4 Trust assumptions

`log_payment` is callable by anyone, but the function validates that the supplied `tx_hash` corresponds to a real payment on Stellar matching the provider's expected destination and asset. In v1, this check is performed off-chain by the Flovia indexer and only attested on-chain. In future versions, we plan to integrate Soroban's cross-contract calls to a payment verification oracle, or move to a model where the provider's middleware itself submits the log call as part of serving the response.

---

### 4. The Trust Score

#### 4.1 Goals

We want a score that is:
- **Deterministic and reproducible.** Given the same inputs, anyone can compute the same score.
- **Transparent.** The breakdown is visible in the UI; users see exactly why a score is what it is.
- **Resilient to gaming.** Each input is hard to fake cheaply.
- **Composable.** Can be improved over time without breaking integrations.

#### 4.2 Formula (v1)

```
TrustScore = round(100 · (w₁·age + w₂·volume + w₃·kyb + w₄·claims + w₅·recency))

age      = min(1, days_since_registered / 90)              w₁ = 0.15
volume   = min(1, log₁₀(usdc_volume_30d + 1) / 4)          w₂ = 0.30
kyb      = { verified: 1.0, pending: 0.3, none: 0.0 }      w₃ = 0.30
claims   = 1 - min(1, disputes_count / payments_count)     w₄ = 0.15
recency  = { 7d: 1.0, 30d: 0.5, older: 0.0 }               w₅ = 0.10
```

#### 4.3 Properties

- A brand-new provider with no KYB, no volume, no history scores ~0.
- A 90+ day provider with KYB tier 2, $10k+ monthly volume, no disputes, recent activity scores ~95-100.
- A provider with KYB but zero volume scores ~45 (the KYB component anchors them, but they need to prove operation to reach high scores).
- A provider can never reach 100 without KYB.

#### 4.4 Roadmap for v2

- **Machine learning re-weighting.** Train weights using outcomes data (which providers actually fulfilled vs. caused disputes).
- **Subjective claims.** Allow other Stellar accounts (especially anchors or other high-Trust providers) to publish signed attestations.
- **Slashing.** Bond requirement to register; bond can be slashed by dispute resolution.

---

### 5. The Agent Interface

#### 5.1 The SDK

Agents integrate through the `@flovia/agent-sdk` package. The primary entry point:

```ts
const flovia = new Flovia({ secret: env.AGENT_SECRET, network: "public" });

const result = await flovia.discoverAndCall({
  need: "fx-rates",
  maxPrice: 0.01,
  kybRequired: true,
  payload: { pair: "EUR/USD" },
});
```

This single call performs: discovery, recommendation, payment construction, signing, submission, verification, and consumption.

#### 5.2 The recommendation engine

The `/api/recommend` endpoint:
1. Filters candidate providers from the registry using the agent's constraints.
2. Computes a composite match score combining Trust Score, price fit, and category match.
3. Passes the top candidates to Claude with a structured prompt, asking for a top-N ranking with reasoning.
4. Returns the JSON to the agent.

The LLM is used for reasoning and explanation, not as the sole arbiter — the underlying scoring is deterministic.

---

### 6. Architecture summary

(See `02-TRD.md` and `05-BACKEND-ESQUEMATICO.md` for component-level detail.)

Flovia is a **Bun monorepo** with five logical packages: `contracts` (Zod data types), `sources` (Stellar SDK clients), `intelligence` (Trust Score, ranker, AI), three applications (`bff`, `frontend`, `cli/indexer`), and a Postgres datastore. The off-chain stack is stateless and reconstructible from the on-chain registry plus Horizon's transaction history at any time.

---

### 7. Security considerations

- **Replay protection.** Memo-based challenge IDs combined with consumed-hash cache prevent replay.
- **Key management.** Agent secrets live in `.env` for the hackathon; production guidance is to use HSM or per-call passkey signing.
- **Verification source of truth.** Always Horizon, never client-supplied transaction data.
- **Reentrancy.** N/A in v1 (no on-chain payment dispatch from the registry).
- **Denial of service on `log_payment`.** Mitigated by per-provider rate limiting and minimum-fee.
- **Trust Score manipulation.** Volume can be self-funded (a provider could pay itself); mitigated in v2 by counting only distinct payer accounts above an age threshold.

---

### 8. Comparison with related work

| System | Cadena | Foco | Diferencia con Flovia |
|---|---|---|---|
| x402 (Coinbase) | EVM, multi | Protocolo de pago | Define protocolo; Flovia agrega inteligencia + KYB. |
| HitPay MPP | Multi | B2B billing | Distinto modelo (suscripciones); no Stellar-native. |
| Chainalysis | Multi | Compliance enterprise | Datos forenses; no agent-facing. |
| Stellar Anchor Directory | Stellar | Listado de anchors | Static directory; no scoring ni para providers de APIs. |

Flovia es complementario a x402 (lo implementa) y a anchors (los consume como fuente de KYB).

---

### 9. Roadmap

| Periodo | Hitos |
|---|---|
| **Hackathon SCF** | Demo testnet, contrato deployado, 5 providers, playground |
| **Mes 1-3** | Mainnet, 50+ providers, 1-2 anchors integrados, SDK en npm |
| **Mes 4-9** | API Pro comercial, scoring v2, 3 clientes Enterprise |
| **Mes 10-18** | Disputes resolution, insurance pool, expansión a anchor partners globales |
| **Año 2+** | Federación con sistemas equivalentes en otras cadenas (puente, no fork) |

---

### 10. Conclusion

The agentic payments economy is not hypothetical — it is being built right now, one tool-using LLM at a time. The friction today is not in moving money, but in deciding *who* to move it to. Stellar, with USDC native, sub-second finality, and a regulated anchor ecosystem, is the natural settlement layer for this economy. Flovia is the intelligence layer that makes it usable. We invite the Stellar community to build with us, on the registry that is already deployed and the SDK that already works.

---

### Appendix A — Bibliografía y referencias

- Stellar Soroban documentation — https://developers.stellar.org/docs/soroban
- USDC on Stellar — https://www.circle.com/en/multi-chain-usdc/stellar
- HTTP 402 protocol discussion — RFC 9110 §15.5.2
- SEP-10 (Stellar Web Auth) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
- SEP-12 (KYC API) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
- Anchor Directory — https://resources.stellar.org/anchors

### Appendix B — Glosario

(Ver `01-PRD.md` § 10.)


---

## Parte 10 — Pitch SCF (7 capas)


> Documento específico para Stellar Community Fund. Pensado para acompañar la aplicación SCF junto con el video de 3 min, el repo y el demo.

---

### TL;DR

Flovia es la **capa de inteligencia que falta en Stellar para que la economía agéntica funcione**. Stellar tiene la mejor primitiva de pago del mundo cripto (USDC nativo, fees ~0, 5s de finalidad). Lo que no tiene es la **infraestructura de decisión** que un agente autónomo necesita antes de mover dinero: catálogo, identidad, verificación, reputación. Flovia lo construye en 7 capas, todas Stellar-native, todas componibles, todas auditables.

**Lo que ya está deployado al cerrar el hackathon:**
- Contrato Soroban en testnet (`C...`)
- Middleware x402-Stellar protegiendo APIs reales
- 5 providers seedeados con datos verdaderos
- Dashboard público y playground end-to-end
- SDK para que cualquier agente lo consuma

---

### Por qué Stellar y nada más

Pudimos elegir cualquier cadena. Elegimos Stellar por **cinco razones técnicas concretas**, no por preferencia:

1. **USDC nativo emitido por Circle directo.** No es un wrapped, no es un bridge. Para un agente que cierra cuentas en dólares, esto es la diferencia entre "production-grade" y "experimento".
2. **Fees efectivamente cero.** Para que un micropago de $0.001 tenga sentido, el costo de la transacción no puede ser $0.50. En Ethereum ni en Solana saturada se sostiene. En Stellar sí.
3. **Finalidad en ~5 segundos.** UX agéntica fluida. Un humano espera 5s sin problema; un agente, todavía mejor.
4. **Anchors regulados** (SEP-10, SEP-12, SEP-24). Es el único ecosistema cripto que tiene KYB nativo en el stack. Para una capa de reputación, esto es oro.
5. **Soroban es joven y limpio.** Menos saturación de proyectos, menos noise, más diferenciación. Y un lenguaje (Rust) que da confianza para infraestructura financiera.

---

### Las 7 capas — detalle por capa

#### Capa 1 — Descubrimiento de pagos

**Qué hace:** indexar todas las APIs que aceptan pagos vía x402-Stellar y exponerlas en un catálogo público y consumible por máquinas.

**Implementación hackathon:**
- Contrato Soroban con función `register_provider`.
- Indexer en Bun que lee eventos `provider_registered` y los persiste en Postgres.
- Endpoint `/providers` y página `/providers` en el frontend.
- 5 providers reales registrados con dominios y endpoints válidos.

**Por qué es importante:** sin discovery, los agentes operan a ciegas. Un catálogo on-chain es la fuente de verdad inmutable que permite componibilidad.

#### Capa 2 — Identidad

**Qué hace:** resolver quién está detrás de cada cuenta Stellar y cada contrato. ¿Es una persona? ¿Una empresa? ¿Un agente? ¿Un anchor?

**Implementación hackathon:**
- Mapeo `account → owner_info` con fuentes:
  - Federación Stellar (SEP-2)
  - DNS TXT records (formato `stellar.org=<G...>`)
  - StellarExpert public profiles
  - Tabla de aliases conocidos (anchors, players grandes)
- En el hackathon, 80% real + 20% mock estructurado (con flag visible).

**Por qué es importante:** identidad es el prerequisito de cualquier evaluación. Sin saber quién es, ninguna otra capa tiene sentido.

#### Capa 3 — Verificación (KYB / KYC)

**Qué hace:** marcar cada provider con un estado de verificación KYB legítimo, basado en evidencias.

**Implementación hackathon:**
- Stub estructurado con 3 estados (`verified`, `pending`, `none`) y campo `source` que documenta de dónde viene la verificación.
- Integración con un anchor SEP-12 de testnet (puede ser mock pero respeta el contrato del estándar).
- Roadmap real: integración con 2-3 anchors productivos en mainnet (mes 1-3).

**Por qué es importante:** para que agentes corporativos o regulados puedan operar, necesitan saber que el destino del pago pasó controles. Stellar es la única red donde esto es estructuralmente posible.

#### Capa 4 — Inteligencia financiera

**Qué hace:** analizar la actividad económica de cada provider: volumen, frecuencia de cobros, pagadores únicos, paths de liquidez en Stellar, balances.

**Implementación hackathon:**
- Datos vivos de Horizon: `listPayments`, balances, last activity.
- Path finding API de Stellar para verificar cómo se mueven los fondos.
- Agregaciones en Postgres (volumen 24h / 30d / lifetime).
- Visualización en la tab `Finance` del perfil del provider.

**Por qué es importante:** los números on-chain son la única fuente confiable de tracción real. Esta capa convierte data en señal.

#### Capa 5 — Reputación (Trust Score)

**Qué hace:** entregar un score 0-100 por provider, **auditablemente calculado** a partir de inputs verificables.

**Implementación hackathon:**
- Fórmula determinística (TRD § 7), 5 factores con pesos públicos.
- Cálculo en `packages/intelligence/trust.ts`, tests unitarios.
- UI muestra el desglose por factor con el peso y el valor crudo.
- Historia persistida en `trust_score_history` para tracking temporal.

**Por qué es importante:** la confianza en pagos automáticos sólo escala si la base es transparente. Una "caja negra de reputación" no es aceptable; una fórmula auditable sí.

#### Capa 6 — IA

**Qué hace:** responder preguntas complejas y generar recomendaciones accionables. Por ejemplo: "dada esta necesidad, ¿cuál es el mejor provider?", o "explicáme por qué este provider tiene Trust Score 87".

**Implementación hackathon:**
- Llamadas a Claude (Anthropic API) desde el BFF con prompts estructurados.
- Salida forzada a JSON validado con Zod.
- Cache de 1 hora para evitar costos repetidos.
- Endpoints: insight (en perfil), recomendación (en `/api/recommend`).

**Por qué es importante:** la IA aquí no es decoración — es lo que vuelve la plataforma usable por otros agentes (LLMs) sin necesidad de programar lógica de matching custom para cada consumer.

#### Capa 7 — Infraestructura para agentes

**Qué hace:** permitir que agentes autónomos consulten la plataforma vía API y, opcionalmente, ejecuten el ciclo completo de pago/consumo.

**Implementación hackathon:**
- API REST documentada (endpoints listados en `05-BACKEND-ESQUEMATICO.md`).
- SDK `@flovia/agent-sdk` con métodos `discover`, `recommend`, `pay`, `discoverAndCall`.
- Playground en `/playground` que muestra el ciclo completo paso a paso.
- Roadmap: MCP server para que LLMs lo carguen como tool nativo.

**Por qué es importante:** todas las otras capas son inútiles si el agente no puede consumirlas en una sola llamada simple. Esta capa es el contrato API de Flovia con el mundo agéntico.

---

### Composabilidad: por qué las 7 capas juntas valen más que la suma

Cada capa puede existir como producto separado. La novedad de Flovia es que **están integradas**, de modo que:

- El **Trust Score (capa 5)** depende de **KYB (capa 3)** y de **inteligencia financiera (capa 4)**.
- La **recomendación de IA (capa 6)** consume **Trust Score (5)** + **identidad (2)** + **descubrimiento (1)**.
- El **SDK (capa 7)** orquesta todo en un solo método.

Cuando un agente llama `flovia.discoverAndCall({...})`, las 7 capas se ejecutan en secuencia. **Esa composición es el producto.**

---

### Alineación con los principios de Stellar

| Principio Stellar | Cómo Flovia lo encarna |
|---|---|
| Inclusión financiera | Bajamos la barrera para que cualquier developer construya un agente económico, sin necesidad de armar su propio stack de reputación. |
| Pagos accesibles | Habilitamos micropagos económicos vía x402-Stellar. |
| Apertura | Todo el código es MIT. El registry está en Soroban público. La fórmula del Trust Score es pública. |
| Interoperabilidad | Compatible con SEPs (SEP-10, SEP-12), con anchors, con StellarExpert. |
| Sostenibilidad | Modelo de negocio realista no extractivo: monetizamos servicios premium, no la infra básica. |

---

### Pedido SCF concreto

**Programa:** SCF Build
**Monto:** $25,000 USD en XLM
**Plazo:** 9 meses, 4 milestones (ver `07-BUSINESS-PLAN.md` § 8)

**Por qué confiar en este equipo:**
- Repo público con POC previo trabajando en pagos agénticos (la auditoría que originó este proyecto).
- Decisión consciente de focalizar 100% en Stellar (no multi-chain dispersa).
- Plan de implementación detallado, día por día, con criterios de éxito.
- Open source desde día 1.

**Compromiso de retorno a la comunidad Stellar:**
- Especificación abierta de x402-Stellar (lista para presentar como propuesta SEP si hay interés).
- SDK público en npm.
- Documentación + tutoriales sobre cómo monetizar APIs en Stellar.
- Contribuciones eventuales al ecosistema de tools de Soroban.

---

### Anexo — Visualización rápida

```
┌────────────────────────────────────────────────────────────┐
│         AGENTE AUTÓNOMO (LLM, bot, workflow)               │
└───────────────────────────┬────────────────────────────────┘
                            │
                            ▼ "necesito X bajo restricciones Y"
              ┌──────────────────────────┐
              │   FLOVIA / 7 LAYERS      │
              │                          │
              │ 7. Agent Infra (API/SDK) │  ← interfaz del agente
              │ 6. AI Recommendations    │  ← Claude
              │ 5. Trust Score           │  ← fórmula pública
              │ 4. Financial Intel       │  ← Horizon data
              │ 3. KYB Verification      │  ← Anchors (SEP-12)
              │ 2. Identity              │  ← Federation, DNS, StellarExpert
              │ 1. Payment Discovery     │  ← Soroban registry
              └─────────────┬────────────┘
                            │
                            ▼ "paga 0.005 USDC a G..."
              ┌──────────────────────────┐
              │   STELLAR NETWORK        │
              │   USDC nativo • 5s • $0  │
              └──────────────────────────┘
```

---

**Flovia hace agéntico el dinero que Stellar ya hizo digital.**


---

## Parte 11 — Migración de `packages/sources`


> Guía archivo-por-archivo para reescribir la capa de fuentes externas del POC, manteniendo intactos `contracts`, `intelligence`, `apps/bff`, `apps/frontend`.

---

### 1. Cambios globales

#### 1.1 Borrar
```
packages/sources/x402-discovery.ts       # CDP-specific
packages/sources/cdp-discovery.ts        # Coinbase Developer Platform
packages/sources/bitquery.ts             # se reemplaza por Horizon directo
packages/sources/zerion.ts               # EVM wallet data
packages/sources/mpp-registry.ts         # HitPay específico
```

#### 1.2 Conservar
```
packages/sources/transport.ts            # HTTP cliente con retry/timeout — útil
packages/sources/index.ts                # se actualiza el barrel
```

#### 1.3 Crear
```
packages/sources/stellar/
├── horizon.ts
├── soroban-rpc.ts
├── usdc.ts
├── stellar-expert.ts
└── index.ts
packages/sources/kyb/
├── sep12-anchor.ts
├── mock.ts
└── index.ts
```

#### 1.4 Dependencias

**Quitar de `package.json`:**
```json
"@solana/web3.js": "...",
"@coinbase/cdp-sdk": "..." (si existe)
```

**Agregar:**
```json
"@stellar/stellar-sdk": "^12.3.0"
```

Instalar: `bun add @stellar/stellar-sdk` desde `packages/sources/`.

---

### 2. `packages/sources/stellar/horizon.ts` — NUEVO

```ts
// packages/sources/stellar/horizon.ts
import { Horizon, Asset, Networks } from "@stellar/stellar-sdk";
import { z } from "zod";

const config = {
  url: process.env.HORIZON_URL || "https://horizon-testnet.stellar.org",
  network: process.env.STELLAR_NETWORK === "public"
    ? Networks.PUBLIC
    : Networks.TESTNET,
};

export const horizon = new Horizon.Server(config.url, { allowHttp: false });
export const networkPassphrase = config.network;

// ───────────────────────────── Account

export async function getAccount(publicKey: string) {
  const acc = await horizon.loadAccount(publicKey);
  return {
    id: acc.account_id,
    sequence: acc.sequence,
    subentryCount: acc.subentry_count,
    balances: acc.balances.map((b: any) => ({
      assetType: b.asset_type,
      assetCode: b.asset_code,
      assetIssuer: b.asset_issuer,
      balance: b.balance,
    })),
    lastModifiedTime: acc.last_modified_time,
  };
}

// ───────────────────────────── Payments

export async function listPayments(
  publicKey: string,
  opts: { limit?: number; order?: "asc" | "desc"; cursor?: string } = {}
) {
  const builder = horizon.payments()
    .forAccount(publicKey)
    .limit(opts.limit ?? 50)
    .order(opts.order ?? "desc");
  if (opts.cursor) builder.cursor(opts.cursor);
  const page = await builder.call();
  return {
    records: page.records.map((p: any) => ({
      id: p.id,
      type: p.type,
      txHash: p.transaction_hash,
      from: p.from,
      to: p.to,
      amount: p.amount,
      assetType: p.asset_type,
      assetCode: p.asset_code,
      assetIssuer: p.asset_issuer,
      createdAt: p.created_at,
    })),
    cursor: page.records.length ? page.records[page.records.length - 1].paging_token : null,
  };
}

// ───────────────────────────── Transaction (for x402 verification)

export async function getTransaction(txHash: string) {
  const tx = await horizon.transactions().transaction(txHash).call();
  const opsPage = await horizon.transactions().transaction(txHash).operations().call();
  return {
    hash: tx.hash,
    successful: tx.successful,
    ledger: tx.ledger_attr,
    memo: tx.memo,
    memoType: tx.memo_type,
    createdAt: tx.created_at,
    operations: opsPage.records.map((o: any) => ({
      type: o.type,
      from: o.from,
      to: o.to,
      amount: o.amount,
      assetType: o.asset_type,
      assetCode: o.asset_code,
      assetIssuer: o.asset_issuer,
    })),
  };
}

// ───────────────────────────── Health

export async function ping(): Promise<boolean> {
  try {
    await horizon.ledgers().limit(1).order("desc").call();
    return true;
  } catch {
    return false;
  }
}
```

---

### 3. `packages/sources/stellar/soroban-rpc.ts` — NUEVO

```ts
// packages/sources/stellar/soroban-rpc.ts
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Account,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { networkPassphrase } from "./horizon";

const sorobanUrl =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

export const sorobanRpc = new rpc.Server(sorobanUrl);

// ───────────────────────────── Simulate (read-only contract call)

export async function simulateContractCall(opts: {
  readerAccount: string;       // any funded account works for simulation
  contractId: string;
  fn: string;
  args: xdr.ScVal[];
}) {
  const contract = new Contract(opts.contractId);
  const account = await sorobanRpc.getAccount(opts.readerAccount);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(opts.fn, ...opts.args))
    .setTimeout(30)
    .build();

  const sim = await sorobanRpc.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  if (!sim.result?.retval) {
    throw new Error("Simulation returned no value");
  }
  return scValToNative(sim.result.retval);
}

// ───────────────────────────── Events (for indexer)

export async function getContractEvents(opts: {
  contractId: string;
  fromLedger: number;
  limit?: number;
}) {
  const res = await sorobanRpc.getEvents({
    startLedger: opts.fromLedger,
    filters: [
      {
        type: "contract",
        contractIds: [opts.contractId],
      },
    ],
    limit: opts.limit ?? 100,
  });
  return res.events.map((e: any) => ({
    ledger: e.ledger,
    timestamp: e.ledgerClosedAt,
    contractId: e.contractId,
    topics: e.topic.map((t: any) => scValToNative(t)),
    value: scValToNative(e.value),
    type: e.type,
  }));
}

// ───────────────────────────── Health

export async function pingSoroban(): Promise<boolean> {
  try {
    await sorobanRpc.getHealth();
    return true;
  } catch {
    return false;
  }
}

export async function getLatestLedger(): Promise<number> {
  const r = await sorobanRpc.getLatestLedger();
  return r.sequence;
}
```

---

### 4. `packages/sources/stellar/usdc.ts` — NUEVO

```ts
// packages/sources/stellar/usdc.ts
import { Asset } from "@stellar/stellar-sdk";

const USDC_ISSUERS = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  public:  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // Circle
};

export const USDC_ISSUER =
  process.env.STELLAR_NETWORK === "public"
    ? USDC_ISSUERS.public
    : USDC_ISSUERS.testnet;

export const USDC = new Asset("USDC", USDC_ISSUER);

export const usdcInfo = {
  code: "USDC",
  issuer: USDC_ISSUER,
  decimals: 7, // Stellar standard
};

/**
 * Convierte un monto en USDC humano-legible (string como "0.005")
 * a stroops (string como "50000") — la unidad on-chain.
 */
export function usdcToStroops(amount: string | number): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return (Math.round(n * 10 ** 7)).toString();
}

export function stroopsToUsdc(stroops: string | number): number {
  const n = typeof stroops === "string" ? Number(stroops) : stroops;
  return n / 10 ** 7;
}
```

---

### 5. `packages/sources/stellar/stellar-expert.ts` — NUEVO (opcional)

```ts
// packages/sources/stellar/stellar-expert.ts
import { fetchWithRetry } from "../transport";

const BASE = process.env.STELLAR_NETWORK === "public"
  ? "https://api.stellar.expert/explorer/public"
  : "https://api.stellar.expert/explorer/testnet";

/**
 * Perfil enriquecido de una cuenta: tags, dominio, alias, etc.
 * Es complementario a Horizon (que sólo da datos crudos).
 */
export async function getAccountProfile(publicKey: string) {
  const res = await fetchWithRetry(
    `${BASE}/account/${publicKey}`,
    {},
    { retries: 2, timeoutMs: 5000 }
  );
  if (!res.ok) return null;
  const data = await res.json() as any;
  return {
    publicKey: data.account,
    tags: data.tags ?? [],
    domain: data.domain ?? null,
    home_domain: data.home_domain ?? null,
    name: data.name ?? null,
    payments: data.payments ?? null,
    created: data.created ?? null,
  };
}
```

---

### 6. `packages/sources/stellar/index.ts` — barrel

```ts
// packages/sources/stellar/index.ts
export * from "./horizon";
export * from "./soroban-rpc";
export * from "./usdc";
export * from "./stellar-expert";
```

---

### 7. `packages/sources/kyb/mock.ts` — NUEVO

```ts
// packages/sources/kyb/mock.ts
//
// MOCK_KYB: Reemplazar en mes 1-3 por integración real con SEP-12 anchor.
// La forma del dato respeta el contrato real.
//

type KybRecord = {
  providerId: string;
  status: "verified" | "pending" | "none";
  kybProvider?: string;       // "anchor:G..."
  kybTier?: 1 | 2 | 3;
  verifiedAt?: string;
};

const MOCKS: Record<string, KybRecord> = {
  // se carga vía seed; placeholders:
};

export async function getKybStatus(providerId: string): Promise<KybRecord> {
  console.warn(`[MOCK_KYB] fetching ${providerId}`);
  return MOCKS[providerId] ?? { providerId, status: "none" };
}

export async function setKybStatus(rec: KybRecord) {
  MOCKS[rec.providerId] = rec;
}
```

---

### 8. `packages/sources/kyb/sep12-anchor.ts` — NUEVO (placeholder real)

```ts
// packages/sources/kyb/sep12-anchor.ts
//
// SEP-12 KYC API integration.
// https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
//
// En hackathon: stub que retorna mock. En mes 1-3: implementación completa.

import { fetchWithRetry } from "../transport";

export async function querySep12Anchor(opts: {
  anchorBaseUrl: string;       // ej. https://api.anchor.example/sep12
  account: string;             // G...
  jwt: string;                 // obtained via SEP-10 flow
}) {
  const res = await fetchWithRetry(
    `${opts.anchorBaseUrl}/customer?account=${opts.account}`,
    {
      headers: { Authorization: `Bearer ${opts.jwt}` },
    }
  );
  if (!res.ok) return null;
  return await res.json();
}
```

---

### 9. Actualizar `packages/sources/index.ts`

```ts
// packages/sources/index.ts
export * as stellar from "./stellar";
export * as kyb from "./kyb";
export * from "./transport";
```

---

### 10. Variables de entorno nuevas (en `.env.example`)

```diff
- # Solana
- SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
- SOLANA_MPP_PAYER_PRIVATE_KEY=
- BITQUERY_API_KEY=
- ZERION_API_KEY=
- CDP_API_KEY=

+ # Stellar
+ STELLAR_NETWORK=testnet
+ HORIZON_URL=https://horizon-testnet.stellar.org
+ SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
+ USDC_ASSET_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
+ REGISTRY_CONTRACT_ID=
+ READER_ACCOUNT=G...            # cuenta cualquiera con fondos para simulate()
+ DEMO_AGENT_SECRET=S...         # cuenta del agente del playground
+ DEMO_PROVIDER_SECRET=S...      # cuenta del provider del playground
```

---

### 11. Actualizar `packages/contracts/`

#### Tipos que se borran
```
packages/contracts/src/solana.ts
packages/contracts/src/bitquery.ts
packages/contracts/src/cdp.ts
packages/contracts/src/zerion.ts
```

#### Tipos nuevos

```ts
// packages/contracts/src/stellar.ts
import { z } from "zod";

export const StellarAccountSchema = z.object({
  publicKey: z.string().regex(/^G[A-Z2-7]{55}$/),
  sequence: z.string(),
  balances: z.array(z.object({
    assetType: z.string(),
    assetCode: z.string().optional(),
    assetIssuer: z.string().optional(),
    balance: z.string(),
  })),
});

export const StellarPaymentSchema = z.object({
  txHash: z.string(),
  from: z.string(),
  to: z.string(),
  amount: z.string(),
  assetCode: z.string(),
  assetIssuer: z.string().optional(),
  memo: z.string().optional(),
  createdAt: z.string().datetime(),
});

export type StellarAccount = z.infer<typeof StellarAccountSchema>;
export type StellarPayment = z.infer<typeof StellarPaymentSchema>;
```

```ts
// packages/contracts/src/provider.ts (NUEVO)
import { z } from "zod";

export const ProviderSchema = z.object({
  id: z.string(),
  contractId: z.string(),
  providerId: z.number(),
  name: z.string(),
  endpoint: z.string().url(),
  priceUsdc: z.number().positive(),
  ownerAccount: z.string(),
  paymentAsset: z.literal("USDC"),
  category: z.string().optional(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.any()).optional(),
});

export type Provider = z.infer<typeof ProviderSchema>;
```

```ts
// packages/contracts/src/trust.ts (NUEVO)
import { z } from "zod";

export const TrustScoreComponentSchema = z.object({
  value: z.number().min(0).max(100),
  weight: z.number(),
  raw: z.string(),
});

export const TrustScoreSchema = z.object({
  total: z.number().int().min(0).max(100),
  components: z.object({
    age: TrustScoreComponentSchema,
    volume: TrustScoreComponentSchema,
    kyb: TrustScoreComponentSchema,
    claims: TrustScoreComponentSchema,
    recency: TrustScoreComponentSchema,
  }),
  computedAt: z.string().datetime(),
});

export type TrustScore = z.infer<typeof TrustScoreSchema>;
```

---

### 12. Actualizar `packages/intelligence/`

#### Borrar
```
packages/intelligence/customer.ts   # era wallet-EVM specific
packages/intelligence/market.ts     # se reescribe
```

#### Nuevo / actualizado

```
packages/intelligence/trust.ts      # ya descrito en TRD § 7
packages/intelligence/ranker.ts     # nuevo
packages/intelligence/ai.ts         # nuevo (Anthropic)
packages/intelligence/prompts/
  insight.ts
  recommend.ts
```

---

### 13. Checklist post-migración

- [ ] `bun typecheck` pasa sin errores en todo el monorepo.
- [ ] `packages/sources/index.ts` solo exporta cosas Stellar.
- [ ] Nada importa de `@solana/web3.js` ni de `bitquery` ni de `zerion`.
- [ ] `apps/bff` arranca y `/health` devuelve `horizon: ok, sorobanRpc: ok`.
- [ ] Test manual: `bun run apps/cli/test-stellar.ts <G>` imprime balances.
- [ ] `.env.example` actualizado, viejas variables Solana removidas.
- [ ] README del repo actualizado (no menciona Solana).
- [ ] El package.json raíz no tiene dependencias EVM/Solana.

---

### 14. Mapping rápido (memoria)

| Concepto viejo (Solana/EVM) | Equivalente Stellar |
|---|---|
| Solana RPC | Horizon + Soroban RPC |
| `@solana/web3.js` | `@stellar/stellar-sdk` |
| Public key Solana (base58) | Account ID Stellar (`G...` base32) |
| Wallet privada (Uint8Array) | Secret seed (`S...`) |
| Bitquery (indexer EVM) | Horizon `/payments`, `/transactions` |
| Zerion (wallet EVM) | Stellar Expert + Horizon |
| CDP (Coinbase) | (no aplica) — el x402 lo implementamos nosotros |
| MPP / HitPay | (no aplica) — el registry lo implementamos en Soroban |
| Token EVM (ERC-20) | Asset Stellar (issuer + code) |
| USDC on Base/Solana | USDC nativo Circle on Stellar |
| Smart contract (Solidity) | Soroban contract (Rust) |
| `eth_sendRawTransaction` | `horizon.submitTransaction(signed)` |
| Memo / call data | Stellar memo (28 bytes) o `manageData` op |


---

## Parte 12 — Código inicial provisto

Junto con este documento, hay dos paquetes de código en `code/` (o donde decidas ubicarlos en el monorepo):

### 12.1 `code/x402-stellar-middleware/`
Middleware HTTP que implementa el protocolo x402 sobre Stellar (USDC nativo). Estructura:

```
x402-stellar-middleware/
├── package.json              # @flovia/x402-stellar v0.1.0
├── README.md
└── src/
    ├── types.ts              # Esquemas Zod del protocolo (X402_VERSION, X402Challenge, etc.)
    ├── verify.ts             # verifyUsdcPayment: consulta Horizon, valida memo/destination/asset/amount
    ├── replay-cache.ts       # Cache TTL 24h de tx_hashes consumidos (idempotencia)
    ├── server.ts             # Middleware Hono: responde 402 con challenge si falta X-PAYMENT, verifica si está
    ├── client.ts             # x402Pay helper: hace GET, parsea 402, construye tx, firma, submit, reintenta
    └── index.ts              # Barrel export
```

**Uso (servidor):**
```ts
import { x402Stellar } from "@flovia/x402-stellar";
import { Hono } from "hono";
const app = new Hono();
app.use("/api/*", x402Stellar({
  destination: process.env.PROVIDER_ACCOUNT!,
  amountUsdc: "0.005",
  network: "testnet",
}));
app.get("/api/rate", (c) => c.json({ pair: "EUR/USD", rate: 1.0843 }));
```

**Uso (cliente agente):**
```ts
import { x402Pay } from "@flovia/x402-stellar/client";
const result = await x402Pay({
  url: "https://provider.example/api/rate",
  agentSecret: process.env.AGENT_SECRET!,
  network: "testnet",
});
```

### 12.2 `code/soroban-registry/`
Contrato Soroban en Rust: registry de proveedores + log de pagos. Estructura:

```
soroban-registry/
├── Cargo.toml                # soroban-sdk 21.7.6
├── README.md
└── src/
    └── lib.rs                # FloviaRegistry contract con:
                              # - initialize(admin)
                              # - register_provider, update_provider, deactivate, activate
                              # - log_payment (con replay protection por tx_hash)
                              # - get_provider, list_providers, get_payment, list_payments
                              # - 5 tests unitarios
```

**Build y deploy:**
```bash
cd contracts/soroban-registry
stellar contract build
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/flovia_registry.wasm \
  --source <admin-secret> --network testnet
# guardar el contract id en .env como REGISTRY_CONTRACT_ID

stellar contract invoke \
  --id $REGISTRY_CONTRACT_ID --source <admin-secret> --network testnet \
  -- initialize --admin <admin-public-key>
```

**Tests:**
```bash
cargo test
```

### 12.3 Eventos del contrato (para el indexer)
- `("registry", "prov_reg", id)` → datos del Provider
- `("registry", "prov_upd", id)` → datos del Provider actualizado
- `("registry", "prov_off", id)` / `("registry", "prov_on", id)` → deactivate/activate
- `("registry", "pay_log", provider_id)` → datos del PaymentLog

El indexer (`apps/cli/indexer.ts`) hace polling de estos eventos desde el último ledger procesado.

---

## Cierre

Este es el contexto completo del proyecto. Cualquier decisión técnica, de producto o de comunicación se toma en consistencia con lo escrito acá. Si en algún momento aparece una contradicción entre partes, gana lo escrito más adelante (las partes están ordenadas de visión a detalle).

**Próximo paso:** Parte 6, Día 1, Ticket 1.1.
