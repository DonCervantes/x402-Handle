# Flovia BFF

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

- `GET /` -> `{ status: "ok", service: "flovia-bff" }`
- `GET /health` -> `{ status: "ok", service: "flovia-bff" }`
- `GET /customers` -> Phase B customer list projection
- `GET /customers/:address/profile` -> Phase B wallet profile projection
- `GET /customers/:address/intelligence` -> Phase B customer intelligence read model
- `GET /wallet-usage-graph` -> Phase B co-usage graph projection
- `GET /analytics/services/coingecko/summary` -> coingecko macro service analytics summary
- `GET /analytics/services/comparison` -> coingecko and public x402 peer service comparison
- `GET /analytics/services/quadrants` -> quadrant-ready service comparison data using average transactions per user vs endpoint diversity
- `POST /stellar/playground/pay` -> server-side demo payment; disabled unless explicitly enabled

The demo endpoint responses follow `docs/phase-b/api-contract.md` and the Phase B schema in `packages/contracts`.
Demo labels and expected future SDK telemetry fields are distinguished by `provenance` / `provenanceByField` / `reasons` in responses.

The Stellar playground payment endpoint is disabled by default, including in
production. To enable it, set `BFF_STELLAR_PLAYGROUND_ENABLED=true`,
`BFF_STELLAR_PLAYGROUND_API_KEY` to a strong secret, and `DEMO_AGENT_SECRET`.
Requests must provide the API key as a bearer token or `X-API-Key`. The endpoint
allows 10 authenticated requests per client IP per UTC day by default;
`BFF_PLAYGROUND_MAX_REQUESTS_PER_DAY` can set a different positive limit. The
limiter is in-memory and therefore applies per BFF process.

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

Read endpoints accept GET only. The Stellar playground payment endpoint is the
only route that performs a payment and requires the explicit safeguards above.
