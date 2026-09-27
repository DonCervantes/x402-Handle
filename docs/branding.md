# Branding and naming decision

**Status:** decided
**Applies to:** the whole monorepo
**Supersedes:** the mixed Flovia / HANDLE naming called out in [#29](https://github.com/DonCervantes/x402-Handle/issues/29) and [#86](https://github.com/DonCervantes/x402-Handle/issues/86).

## Decision

There is **one product: HANDLE**. "Flovia" is a retired product name, not a second product, a sub-brand, or a separate service. Anything a user reads — the README, the BFF's advertised service name, payment memos, UI copy — says **HANDLE**.

A small set of **machine identifiers** keep their `flovia` spelling because renaming them is a breaking change with no user-visible benefit. They are published coordinates and wire fields, not product names, and they are listed exhaustively below so the two layers never get confused again.

## Identifiers that stay `flovia`

| Identifier | Where | Why it stays |
| --- | --- | --- |
| `@flovia/agent-sdk` | `packages/agent-sdk/package.json` | Published npm scope. Renaming changes an import specifier for every consumer and requires a new publish on a new scope; it must happen in a dedicated, announced release, not as an incidental rename. |
| `@flovia/x402-stellar` | `packages/x402-stellar/package.json` | Same: published import specifier (`import { x402Stellar } from "@flovia/x402-stellar"`). |
| `flovia-poc` | root `package.json` `name` | Private workspace name, never published or shown to users. Renaming churns lockfiles for zero benefit. |
| `floviaEvent` | BFF showcase response bodies (`apps/bff/src/showcase/*`) | Machine-readable response field consumed by the frontend and asserted in `apps/bff/tests/showcase-routes.test.ts`. It is a wire contract, not a label a user reads. |
| `x-flovia-showcase-pay` | BFF showcase request header | Same: a request-header contract between the demo pages and the BFF. |
| `docs/FLOVIA-STELLAR.md`, `docs/showcase/showcase-mpp-flovia-sdk-integration.md`, `apps/bff/src/showcase/flovia-track-paid-api.ts`, `scripts/*` filenames | repository paths | File and document slugs referenced from other docs and from code paths. Renaming them is a churn-only change; their *content* is being updated to the single-product framing instead. |

> Rule of thumb: if a human sees it rendered, it says **HANDLE**. If it is an import specifier, a JSON key, an HTTP header, or a file path that code and tests reference, it may keep `flovia` and must be listed in the table above.

## User-facing names that must say HANDLE

| Surface | Before | After |
| --- | --- | --- |
| Product name in root docs | `Flovia` | `HANDLE` |
| BFF advertised service name (`GET /`, `GET /health`, health sub-checks) | `flovia-bff` | `handle-bff` |
| BFF startup log line | `Flovia BFF listening on …` | `HANDLE BFF listening on …` |
| Stellar payment memo label issued with a 402 challenge | `fl-<10 hex>` | `hnd-<10 hex>` |
| `apps/bff/README.md` title and endpoint examples | `Flovia BFF` | `HANDLE BFF` |

### Note on the memo label

`packages/x402-stellar` generates one memo per 402 challenge and the verifier compares the settlement memo against the challenge it issued. Because the same middleware both issues and validates the label, changing the prefix is safe *within a deployment*; a challenge that was issued but not yet settled across a deploy boundary will fail with `memo_mismatch` and must be re-requested. `"hnd-" + 10 hex` is 14 bytes, still comfortably inside Stellar's 28-byte text memo limit.

## Consequences

- `bun run verify` (tests + typecheck) is the gate: the BFF route tests assert the advertised service name, so the rename is covered by the existing suite.
- No `@flovia/*` import specifier changes in this decision, so no downstream project needs to update a dependency.
- When the packages are eventually republished under a new scope, that release should delete the first three rows of the "stays" table and be announced as a breaking change.
