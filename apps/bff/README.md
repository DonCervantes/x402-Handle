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
- `GET /aeo/x402/snapshot` -> signed x402 discovery catalog (see below)
- `GET /aeo/x402/signing-key` -> public Ed25519 key that verifies the snapshot

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

## Signed x402 discovery snapshots

`GET /aeo/x402/snapshot` returns the discovery catalog the BFF holds in memory,
wrapped in an envelope agents can verify offline:

```jsonc
{
  "version": 1,
  "alg": "Ed25519",
  "keyId": "…",                 // from GET /aeo/x402/signing-key
  "source": "seed" | "live",    // committed baseline vs. a facilitator refresh
  "generatedAt": "2026-10-20T06:00:00.000Z", // when the data was produced, not when it was loaded
  "staleFacilitators": [],      // facilitators kept from an older pull because the last refresh failed
  "digest": "sha256:…",         // sha256 of canonical JSON of `data`
  "data": { "cdp": [], "dexter": [], "payai": [] },
  "signature": "…"              // base64url Ed25519 over canonical JSON of every field except data/signature
}
```

- The signature comes from `BFF_DISCOVERY_SIGNING_KEY`; only the public key is
  served, at `GET /aeo/x402/signing-key` (`{ alg, keyId, publicKey, ephemeral, maxAgeSeconds }`).
  Without the env var the BFF signs with an ephemeral key (`"ephemeral": true`).
- Verifying needs only that public key. The refresh token is never required.
- **Max age: 24 hours** (`DISCOVERY_SNAPSHOT_MAX_AGE_MS` in `packages/contracts`).
  The production cron refreshes twice a day, so 24h tolerates one missed run.
  Agents must reject anything older, and anything whose `generatedAt` is more
  than 5 minutes in the future.
- Provenance is persisted as `meta.json` next to the discovery files, so a
  refreshed snapshot loaded after a restart still reports `live` and its real
  `generatedAt`. The committed seed records when it was captured, so it is never
  presented as fresh. A refresh where every facilitator failed keeps the old provenance.

Agents verify with `@flovia/agent-sdk`:

```ts
import { Flovia, verifyDiscoverySnapshot } from "@flovia/agent-sdk";

// publicKey: pinned from GET /aeo/x402/signing-key (out of band, once).
const snapshot = await flovia.discoverySnapshot({ publicKey });
// or, for a snapshot obtained any other way:
verifyDiscoverySnapshot(json, { publicKey, maxAgeMs: 24 * 60 * 60 * 1000, allowedSources: ["live"] });
```

`verifyDiscoverySnapshot` throws `DiscoverySnapshotError` with a `code`:
`malformed`, `unknown_key`, `bad_digest`, `bad_signature`, `expired`,
`not_yet_valid` or `source_not_allowed`.

## Read-only policy

Demo endpoints accept GET only. Non-GET methods do not perform write operations and return an error response aligned with the read-only policy.
