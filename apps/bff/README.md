# HANDLE BFF

The BFF is a read-only demo API boundary for the frontend demo.

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

- `GET /` -> `{ status: "ok", service: "handle-bff" }`
- `GET /health` -> `{ status: "ok", service: "handle-bff" }`
- `GET /customers` -> Phase B customer list projection
- `GET /customers/:address/profile` -> Phase B wallet profile projection
- `GET /customers/:address/intelligence` -> Phase B customer intelligence read model
- `GET /wallet-usage-graph` -> Phase B co-usage graph projection
- `GET /analytics/services/coingecko/summary` -> coingecko macro service analytics summary
- `GET /analytics/services/comparison` -> coingecko and public x402 peer service comparison
- `GET /analytics/services/quadrants` -> quadrant-ready service comparison data using average transactions per user vs endpoint diversity

The demo endpoint responses follow `docs/phase-b/api-contract.md` and the Phase B schema in `packages/contracts`.
Demo labels and expected future SDK telemetry fields are distinguished by `provenance` / `provenanceByField` / `reasons` in responses.

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

## Read-only policy

Demo endpoints accept GET only. Non-GET methods do not perform write operations and return an error response aligned with the read-only policy.
