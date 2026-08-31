> **⚠️ Legacy document.** This file describes the earlier Flovia PoC (Solana/EVM era).
> The project has since pivoted to **HANDLE / Stellar**. For current architecture, see the [root README](../README.md) and [`docs/FLOVIA-STELLAR.md`](FLOVIA-STELLAR.md).

# Flovia PoC Status (Legacy — Solana/EVM era)

## Current status

Phase A is **core complete**. Phase B is judged complete up to the BFF
canonical API, customer intelligence endpoint, and frontend adapter
integration.

```text
Phase A core: done
Phase A hardening: follow-up possible
Phase B demo BFF: real tx fact + mock attribution projection done
Phase B customer intelligence endpoint: prepared read model done
Phase B frontend integration: client / adapter / 3 BFF-backed screens connected
Phase B end-to-end demo flow: follow-up possible
```

## Phase A: data foundation

### Assessment

`docs/spec.md` indicates that Phase A is currently implemented as the
market snapshot and intelligence foundation by `apps/cli` and `packages`.

### Implemented

- `packages/contracts`
  - Provides Zod schemas, TypeScript types, and normalization helpers.
  - Works as the contract boundary for source facts, market snapshot, and
    Phase B canonical responses.
- `packages/sources`
  - Owns CDP Discovery and Bitquery source adapters.
  - Handles pagination, response parsing, and normalization to contracts.
  - For CoinGecko `payTo`, provides `fetchPaymentTransfersByPayTo()` and supports
    paginated Base USDC transfer retrieval with a default of 1,000 items and
    more than 1,000 when an explicit limit is set.
- `packages/intelligence`
  - Handles scope filtering, joins, active wallet detection, ranking,
    discrepancy handling, and snapshot generation.
- `apps/cli`
  - Handles batch orchestration, argument processing, source-intelligence wiring,
    and JSON / Markdown report output.
- import boundary
  - Boundary checks are defined in `scripts/check-import-boundaries.ts`.
  - It enforces allowed imports within `packages/*` and the prohibition of
    `apps/bff -> apps/cli`.
- tests / verification
  - Typecheck and tests for contracts, sources, intelligence, cli, bff, and
    frontend run via `bun run verify`.

## Phase B: demo BFF

### Assessment

The initial Phase B scope, the **read-only product API boundary for the
frontend demo**, is now implemented on the BFF side.

The frontend is integrated under `apps/frontend`. The three screens—Customers,
Wallet 360°, and Co-usage Patterns—render BFF canonical responses by converting
them to UI DTOs through the API client and adapter layer. Setup builds local UI
state and does not depend on BFF product endpoints.

Automated verification currently focuses on typecheck, unit tests, and BFF route
tests; full browser walkthroughs or E2E demos are not yet in place.

### Implemented

- `apps/bff`
  - Provides read-only product endpoints for `GET`.
  - Returns `405` for non-`GET` requests, matching the read-only policy.
  - Returns JSON `404` for unpublished routes.
  - `GET /customers/:address/intelligence` returns the prepared read model and does
    not call live sources on the request path.
- Phase B canonical contract
  - `packages/contracts` defines schemas and validators for Phase B customer list,
    customer profile, and wallet usage graph.
  - Responses use canonical shape with envelopes, strict schemas, ISO datetimes,
    atomic amount strings, and provenance.
- real tx fact + mock attribution projection
  - Stores a CoinGecko Base USDC `payTo` transaction fact fixture in
    `apps/bff/fixtures/phase-a/coingecko-transactions.json`.
  - Stores `txHash`-keyed mock endpoint attribution in
    `apps/bff/fixtures/phase-b/mock-attribution.json`.
  - Mock attribution is assigned deterministically across all real transaction
    facts so projections reflect captured volume.
  - The fixture can be regenerated from live capture with:
    `bun --cwd apps/cli coingecko:transactions -- --from ... --to ... --limit ...`.
  - `apps/bff/src/data/projection-builder.ts` joins by `txHash` and builds customer
    list, profile, and wallet usage graph projections.
  - Validation is performed at module initialization using the Phase B validator
    in `packages/contracts`.
- docs
  - `docs/phase-b/api-contract.md` documents canonical contracts, provenance
    contracts, and deferred endpoints.
  - `docs/phase-b/demo-data.md` defines demo data and provenance labeling rules.
  - `apps/bff/README.md` documents BFF endpoints, unpublished endpoints, and
    the read-only policy.
- `apps/frontend`
  - `lib/api/client.ts` fetches `/customers`, `/customers/:address/profile`, and
    `/wallet-usage-graph`.
  - API responses are validated with Phase B validators in `packages/contracts`
    before adapter conversion.
  - `lib/api/adapters.ts` converts canonical responses into existing UI DTOs.
  - Customers, Wallet 360°, and Co-usage Patterns screens render BFF-backed data.
  - `providerId` is currently used only for routing/display, not for BFF query
    or provider scope filtering.

### Published endpoints

```text
GET /
GET /health
GET /customers
GET /customers/:address/profile
GET /customers/:address/intelligence
GET /wallet-usage-graph
```

Product endpoints follow the Phase B schema in
`docs/phase-b/api-contract.md` and `packages/contracts`.

### Endpoints deferred from initial implementation

```text
GET /demo-data
GET /sdk-events
GET /telemetry
GET /mock-attribution
GET /patterns
GET /summary
```

`GET /patterns` was initially considered, but in the current canonical initial
scope it is deferred as a standalone endpoint. The co-usage / pattern demo story
is represented inside the `GET /wallet-usage-graph` response.

## Phase B data classification

Phase B BFF responses must not mix values sourced from live data with values from
demo or future telemetry. The provenance of each field must be explicit.

### Live data-derived (Phase A) values

Phase A data foundation values are obtained from source facts or can be regenerated
from Phase A snapshot/projection.

- `pay_to` / recipient
- payer wallet / customer wallet
- network / asset
- payment activity / payment frequency
- active wallet determination
- customer ranking / payer quality
- CDP resource / payment option
- Bitquery payTo aggregate
- market snapshot
- customer wallet projection
- wallet profile projection
- co-usage graph projection
- product / resource candidate cluster
- confidence and evidence components derived from onchain facts

In Phase B, these values are returned by BFF as a prepared demo dataset,
fixture, or a Phase A snapshot-equivalent read model, without calling live
sources on the request path.

Current CoinGecko Base USDC observed values are:

```text
payTo: 0x110cdbba7fe6434ec4ce3464cc523942ad6fb784
transactionCount: 628
uniqueSenderCount: 75
latestTxHash: 0x6248880ec36541e6783ab756afdb427939f6209551b751cec5a2c97f71176d94
latestSender: 0xac5a07c44a4f971667b3df4b6551fb6991b2142d
latestBlockTimestamp: 2026-04-29T04:11:53Z
```

Current fixture capture spans `2026-01-01T00:00:00Z` to
`2026-04-29T23:59:59Z`, saving 1,908 unique valid transaction facts with
`requestedLimit: 5000`.

### Values not yet backed by live data

These values cannot be confirmed with Phase A onchain-first data, so they are
treated as `demo_label` or `future_sdk_field` in Phase B.

- source / medium candidate
- referrer-like label
- campaign-like label
- workflow / use case candidate
- endpoint candidate
- endpoint usage frequency
- endpoint attribution
- workflow sequence
- agent type inference
- provider-specific funnel
- plan / monetization context
- retention / upsell / partnership insight narratives and hypotheses

The above values require future SDK middleware, provider attribution data,
request paths, resource context, provider-side events, and endpoint-level
request telemetry to become live data.

### Handling in API responses

Each response field must include at least one of:

- `onchain_fact`: values explainable by Phase A source facts, snapshots, or
  projections
- `demo_label`: fixture values prepared for the frontend decision-making
  experience
- `future_sdk_field`: values expected to become live once SDK telemetry is
  integrated
- `derived_insight`: insights or hypotheses built from `onchain_fact` and
  `demo_label`

If `derived_insight` includes `demo_label` or `future_sdk_field` in its basis, it
must not be treated as live data.

## Remaining hardening

### Phase A hardening

- Strengthen import boundary coverage
  - `packages/* -> apps/*` is effectively enforced through package-allowed
    imports.
  - Mutual imports between `packages/sources` and `packages/intelligence` are
    effectively enforced through package-allowed imports.
  - `apps/bff -> apps/cli` prohibition has been checked.
  - Next, formalize inter-app dependency rules and explicitly enforce paths such
    as `apps/cli -> apps/bff` if needed.
- Generalize Bitquery implementation
  - Current implementation is strongly Base USDC-specific.
  - Extend this in the source adapter layer when adding more networks/assets.
- Clarify snapshot contract semantics
  - Phase B provenance contracts were added.
  - Next, make the Phase A snapshot versus Phase B projection boundary clearer in
    the generation pipeline.

### Phase B hardening

- Externalize BFF demo data into fixtures and projection store
  - Replaced in-file deterministic read model with a split implementation of
    real transaction fixture, mock attribution fixture, and projection builder.
  - Next, persist projection output as generated JSON where needed.
- Validate frontend integration
  - API client, adapter, and three-screen integration are implemented in
    `apps/frontend`.
  - Adapter conversion from canonical response to UI DTO is covered by unit tests.
  - Next, add browser-verified demo flow or E2E testing for the running
    Next.js app and BFF.
- Clarify endpoint scope / provider scope
  - BFF currently returns a prepared demo read model.
  - Adding provider scope via query/header is deferred to a later change.
- Finalize `GET /patterns` treatment
  - Not exposed currently.
  - Add contract, fixture, BFF route, and frontend adapter together when a
    standalone endpoint becomes necessary.

## Not now

- Calling live CDP / Bitquery / RPC on BFF request path
- Implementing SDK middleware itself
- Live data estimation for endpoint / workflow / MRR
- Solana parser
- Authentication, billing, and production multi-tenancy

## Next actions

The next step is to complete **Phase B demo-flow verification and scope
alignment**.

Priority:

1. Run BFF and frontend together, then verify Setup, My Customers, Wallet 360°,
   and Co-usage Patterns demo flow in a browser.
2. Add E2E or smoke tests where needed to automate the minimum end-to-end
   verification for the three BFF-backed screens.
3. Decide whether to move provider and endpoint scope into query/header/API
   contract, or keep them only for demo routing/display.
4. Add a standalone `GET /patterns` endpoint in a contract-first manner only if
   required.

## One-line summary

Phase A data foundation is complete. Phase B has completed the BFF canonical API,
customer intelligence endpoint, and frontend adapter integration; next steps are
demo-flow verification and scope alignment.
