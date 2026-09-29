# Flovia BFF

The BFF is the demo API boundary for the frontend demo. It is **not** GET-only:
its product endpoints are read-only `GET` routes, and a small set of privileged
`POST` routes perform state-changing actions (see [HTTP method policy](#http-method-policy)).

In Phase B, it provides read-only demo endpoints that return prepared read models.
The current BFF does not depend on `apps/cli` and returns responses in a canonical envelope that follows the Phase B contract in `packages/contracts`.

## Commands

```bash
bun install
cd apps/bff
bun run start
bun run verify
```

## Endpoints

### Read-only product `GET` routes

- `GET /` -> `{ status: "ok", service: "flovia-bff" }`
- `GET /health` -> `{ status: "ok", service: "flovia-bff" }`
- `GET /customers` -> Phase B customer list projection
- `GET /customers/:address/profile` -> Phase B wallet profile projection
- `GET /customers/:address/intelligence` -> Phase B customer intelligence read model
- `GET /wallet-usage-graph` -> Phase B co-usage graph projection
- `GET /analytics/services/coingecko/summary` -> coingecko macro service analytics summary
- `GET /analytics/services/comparison` -> coingecko and public x402 peer service comparison
- `GET /analytics/services/quadrants` -> quadrant-ready service comparison data using average transactions per user vs endpoint diversity

The demo endpoint responses follow `docs/phase-b/api-contract.md` and the Phase B schema in `packages/contracts`.
Demo labels and expected future SDK telemetry fields are distinguished by `provenance` / `provenanceByField` / `reasons` in responses.

### Privileged `POST` routes

These routes change state. "No auth" means anyone who can reach the BFF can trigger the action.

| Method + path | What it does | Auth / gate (as implemented) |
| --- | --- | --- |
| `POST /stellar/playground/pay` | Body `{ "providerId": string }`. Runs a real x402 payment server-side (`src/data/stellar-playground.ts`), signed with `DEMO_AGENT_SECRET` (`maxAmountUsdc: 0.01`, network from `STELLAR_NETWORK`, default `testnet`). Only the live demo provider (`providerId` 1) is paid. | **No auth.** `400` if `providerId` is missing; `422` if the payment is not made (including `misconfigured` when `DEMO_AGENT_SECRET` is unset). |
| `POST /aeo/x402/refresh` | Triggers a live x402 discovery refresh and replaces the served discovery data. | **Shared-secret bearer token:** `Authorization: Bearer <token>` or `X-Refresh-Token: <token>`, compared in constant time against `BFF_X402_REFRESH_TOKEN`. `403` if the env var is unset (route disabled); `401` if the token is missing or wrong. |
| `POST /showcase/stripe-mpp/pay` | Pays `/showcase/stripe-mpp/paid` over Stripe MPP (Tempo testnet) with the server-side `MPPX_PRIVATE_KEY` wallet (`src/showcase/stripe-mpp-paid.ts`). | **No auth.** Requires the header `x-flovia-showcase-pay: stripe-mpp` (`400` otherwise). This is a fixed, public value, not a secret. `503` if `MPPX_PRIVATE_KEY` is unset or malformed. |
| `POST /showcase/solana-mpp/pay` | Pays `/showcase/solana-mpp/paid` over Solana MPP (network from `SOLANA_MPP_NETWORK`, default `devnet`) with the server-side `SOLANA_MPP_PAYER_PRIVATE_KEY` wallet (`src/showcase/solana-mpp-paid.ts`). | **No auth.** Requires the header `x-flovia-showcase-pay: solana-mpp` (`400` otherwise). This is a fixed, public value, not a secret. `503` if `SOLANA_MPP_PAYER_PRIVATE_KEY` is unset or invalid. |

The following endpoints are not exposed in the initial Phase B implementation.

- `GET /demo-data`
- `GET /sdk-events`
- `GET /telemetry`
- `GET /patterns`
- `GET /summary`

## Data source

The current BFF returns deterministic fixtures / read models from `apps/bff/src/data/phase-b-demo.ts`.
Fixtures are validated by `packages/contracts` validators during module initialization.
Service analytics reuse the prepared coingecko transaction fixture, mock endpoint attribution fixture, and customer intelligence fixture.
Peer x402 service analytics are sparse fixture-context comparisons, not live global market totals; responses include provenance and sample-basis fields for explanation.

If future market intelligence endpoints are extended, it will also read generated snapshots, projections, or stored data.
The policy is not to issue live CDP / Bitquery / RPC / SDK collector calls per user request.

## HTTP method policy

- Read-only product routes accept `GET` only and do not change state on the BFF.
- The four privileged `POST` routes listed above are the only non-`GET` handlers. They are dispatched in `src/http.ts`.
- A non-`GET` request to a read-only route (the fixed paths in `readonlyRoutes` in `src/http/routes.ts`, the `/customers/:address/...` routes matched by `matchCustomerRoute`, `/providers/:providerId`, and the `/showcase/*` routes) that is not one of the privileged `POST` routes returns `405` with `Allow: GET`.
- Any other non-`GET` request returns JSON `404`. This includes `/stellar/providers/:id` and `/stellar/providers/:id/intelligence`.
