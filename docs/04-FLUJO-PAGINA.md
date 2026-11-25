# Flujo de la página — Flovia Stellar

Este documento describe los **journeys completos** para los tres tipos de usuario, mapeando cada acción a la pantalla, al endpoint del BFF, y al efecto on-chain cuando aplique.

---

## 1. Journey: Visitante / Reviewer SCF (público)

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

## 2. Journey: Desarrollador de agente

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

## 3. Journey: Proveedor de API

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
     │   import { createPostgresReplayStore, x402Stellar } from '@flovia/x402-stellar';
     │   const replayStore = createPostgresReplayStore({ sql: sharedDatabase });
     │   app.use('/api', x402Stellar({
     │     destination: 'G...',
     │     amountUsdc: '0.005',
     │     network: 'testnet',
     │     replayStore
     │   }));
     │
     ▼
  Primer agente lo consume → primer pago registrado en Horizon → Trust Score se actualiza.
```

---

## 4. Flujo de datos (pantallas ↔ servicios)

### 4.1 Carga inicial del catálogo (`/providers`)

```
Browser ──GET /providers──► BFF ──SELECT * FROM providers──► Postgres
                            │
                            └──GET /providers?fresh=1──► Soroban RPC (refresh on-demand)
```

### 4.2 Perfil de proveedor (`/providers/[id]`)

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

### 4.3 Recomendación (`/api/recommend`)

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

## 5. Estados globales del frontend

Manejados con **React Server Components** + cliente cuando hace falta interactividad. Sin Redux/Zustand para el hackathon.

| Estado | Dónde vive | Refresh |
|---|---|---|
| Listado de providers | RSC en `/providers/page.tsx` | revalidate 60s |
| Detalle provider | RSC en `/providers/[id]/page.tsx` | revalidate 30s |
| Stats globales | RSC en `/page.tsx` | revalidate 60s |
| Playground state | useState en cliente | n/a |
| AI insight | server-side cache | TTL 1h |

## 6. Error paths importantes

| Punto | Error posible | UX |
|---|---|---|
| `/api/recommend` | No hay providers que cumplan | UI: "No matches. Relax filters?" |
| `/api/pay/prepare` | Cuenta del agente sin fondos | UI: link al friendbot testnet + instrucciones |
| Submit a Horizon | Tx rechazada (memo dup, etc.) | UI: error específico + link al Horizon response |
| Provider endpoint | 5xx aunque pago OK | Refund automático? No — flag de incidente en Trust Score |
| Soroban RPC down | Indexer no actualiza | Banner global: "Live data delayed" |
| Claude API timeout | Insight no carga | Sección AI muestra "Unavailable, [retry]" — el resto sí carga |

## 7. Analytics mínimo (sin tracking invasivo)

Eventos a registrar en el BFF (no en el cliente) para reporte SCF:
- `recommend.requested` (con need category)
- `pay.prepared`, `pay.verified`, `pay.failed`
- `provider.registered`
- `playground.started`, `playground.completed`

Almacenar en tabla `events` con timestamp y payload JSON. Render en `/stats`.
