# Soroban registry threat model

**Issue:** [#87](https://github.com/DonCervantes/x402-Handle/issues/87)
**Scope:** `contracts/soroban-registry/src/lib.rs` (contract `FloviaRegistry`, 13 exported methods, 6 `DataKey` variants)
**Companion document:** [Stellar Public mainnet go-live checklist](stellar-mainnet-go-live-checklist.md) — the release gate this threat model feeds. This document is **not** a second checklist: the go-live checklist stays the single gate and remains **NO-GO** until its items are checked or waived in issue #41.

This threat model covers the four threats required by #87: `log_payment` called without auth, missing pause functionality, TTL expiry, and unbounded list calls. Each threat names the real functions, storage keys, and call paths it uses, plus a severity and a recommended mitigation.

Severity scale: **Critical (P0)** = must be fixed or explicitly waived before any Public deploy; **High (P1)** = must be fixed before Public, tracked with an owner and a date.

## Storage layout under attack

| `DataKey` variant | Storage type | Written by | Read by |
|---|---|---|---|
| `Admin` | instance | `initialize(admin)` | `admin()` |
| `ProviderCounter` | instance | `initialize`, `register_provider` | `provider_count()` |
| `PaymentCounter` | instance | `initialize`, `log_payment` | `payment_count()` |
| `Provider(u64)` | persistent | `register_provider`, `update_provider`, `deactivate`, `activate` | `get_provider`, `list_providers`, `update_provider`, `deactivate`, `activate`, `log_payment` |
| `Payment(u64)` | persistent | `log_payment` | `get_payment`, `list_payments` |
| `TxConsumed(BytesN<32>)` | persistent | `log_payment` | `log_payment` (replay `has()` check) |

Auth pattern as implemented today:

- `owner.require_auth()` is called in `register_provider`, `update_provider`, `deactivate`, and `activate`.
- `initialize`, `admin()`, every read method (`get_provider`, `provider_count`, `list_providers`, `get_payment`, `payment_count`, `list_payments`), and `log_payment` perform **no** auth check at all.
- `Error::Unauthorized` (code 3) is declared in the `Error` enum but is never raised by any code path.
- No method calls `extend_ttl` — neither `env.storage().persistent().extend_ttl(...)` nor `env.storage().instance().extend_ttl(...)` appears anywhere in the contract.
- There is no `pause`/`unpause`/`transfer_admin` entry point; `DataKey::Admin` is written once by `initialize` and only read back by `admin()`.

---

## T1 — `log_payment` is callable without auth

| | |
|---|---|
| **Severity** | **Critical (P0)** |
| **Tracking** | [#8](https://github.com/DonCervantes/x402-Handle/issues/8) |
| **Checklist gate** | Go-live checklist → *Prerequisite security issues* → "Issue #8 — `log_payment` authorization" |

**Call path.** Any Stellar account → `log_payment(provider_id, payer, amount, tx_hash)`:

1. Reads `DataKey::Provider(provider_id)` from persistent storage and panics `NotFound` if missing — but never checks `provider.active`, and the loaded `Provider` is discarded (`let _ = provider;`) without consulting `provider.owner` or `provider.payment_token`.
2. Checks `DataKey::TxConsumed(tx_hash)` with `persistent().has(...)`; panics `PaymentAlreadyLogged` if the hash was seen. This is the **only** guard in the function.
3. Writes `DataKey::Payment(counter)` (persistent), writes `DataKey::TxConsumed(tx_hash)` (persistent), bumps `DataKey::PaymentCounter` (instance).
4. Emits `("registry", "pay_log", provider_id)` with the full `PaymentLog` — this event is what the indexer persists as volume for Trust Score.

There is no `require_auth()` on the caller, the `payer`, or the provider owner, and `payer`/`amount` are caller-supplied values stored verbatim.

**Impact.** Volume forgery: anyone can attach arbitrary `amount` values to any registered provider for the cost of a Soroban transaction fee. No Horizon proof ties `tx_hash` to a real payment. The registry becomes the root of a forged trust layer for the indexer/BFF.

**Mitigation / recommendation.**

- Require auth from the provider owner or an allowlisted logger/oracle address; raise the already-declared `Error::Unauthorized` for everyone else (this also gives #76 its logger allowlist a shared implementation point).
- Do not trust caller-supplied `amount` without on-chain or Horizon attestation of the referenced transaction.
- Reject payments for `provider.active == false` providers.
- Add tests asserting an unauthorized caller fails (tests currently use `env.mock_all_auths()` for everything, which hides this gap).

---

## T2 — Missing pause functionality (no emergency stop)

| | |
|---|---|
| **Severity** | **High (P1)** |
| **Tracking** | [#76](https://github.com/DonCervantes/x402-Handle/issues/76) (replaces closed #18; open PR [#63](https://github.com/DonCervantes/x402-Handle/pull/63)) |
| **Checklist gate** | Go-live checklist → *Prerequisite security issues* → "Issue #18 — pause and admin transfer" (checklist text still names #18; the successor issue is #76) |

**Call path.** The threat is an *absent* call path: there is no entry point that halts writes.

- `DataKey::Admin` exists in instance storage and `admin()` exposes it, but no mutating method consults it. `initialize(admin)` is the only place the admin is ever written.
- `deactivate(provider_id)` only flips `active` on a single provider and requires that provider's owner signature — it cannot stop `log_payment`, cannot freeze the counters, and is useless against a compromised owner key.
- There is no `transfer_admin`, so a lost or compromised admin key is permanent: the contract has no upgrade path either, so it cannot be migrated away.

**Impact.** If `log_payment` is abused (T1) or a malicious provider is registered (spoofed `endpoint`/`payment_token`), operators have no incident lever. Events keep flowing to the indexer; there is no way to freeze the registry or rotate admin authority while a key is being revoked.

**Mitigation / recommendation.**

- Admin-only `pause()` / `unpause()` checked at the top of every mutating method (`register_provider`, `update_provider`, `deactivate`, `activate`, `log_payment`), reading admin from `DataKey::Admin`.
- Two-step `transfer_admin` (propose + accept) so a typo cannot burn the admin key.
- Combine with the #76 logger allowlist for `log_payment`.
- Document the incident procedure (which the go-live checklist already requires under *Mainnet configuration and operations*) and test pause behavior with explicit signer auth, not `mock_all_auths`.

---

## T3 — TTL expiry of persistent and instance entries

| | |
|---|---|
| **Severity** | **Critical (P0)** |
| **Tracking** | [#88](https://github.com/DonCervantes/x402-Handle/issues/88) (replaces closed #33) |
| **Checklist gate** | Go-live checklist → *Testnet evidence* → "Persistent storage TTL extension has been implemented and tested…" |

**Call path / TTL usage.** The contract never calls `extend_ttl`:

- Every persistent write — `Provider(u64)` in `register_provider`/`update_provider`/`deactivate`/`activate`, `Payment(u64)` and `TxConsumed(tx_hash)` in `log_payment` — leaves the entry at the network's minimum persistent TTL (4096 ledgers on Public, ≈ 5.7 h at 5 s per ledger) unless an outside party extends it with `ExtendFootprintTTLOp`.
- Instance data (`Admin`, `ProviderCounter`, `PaymentCounter`) shares the contract instance entry's TTL, which is likewise never extended from `initialize` or from any mutating call.

**Impact.**

- **Providers disappear:** once `Provider(id)` archives, `get_provider` and `list_providers` either fail or force paid restoration on every read; the catalog silently empties.
- **Payment history breaks:** archived `Payment(id)` entries make `get_payment`/`list_payments` unusable for the indexer.
- **Replay protection degrades:** `TxConsumed(tx_hash)` is the only replay guard. Once archived, access to it either fails the transaction or triggers paid automatic restoration — and if the entry is past the restorable window and purged, the same `tx_hash` can be logged again, double-counting volume. The replay guarantee silently degrades with time instead of being permanent.
- **Instance archival takes the contract down:** if the instance entry (or WASM code entry) archives, every call to `FloviaRegistry` fails until someone pays for restoration.

**Mitigation / recommendation.**

- Extend persistent TTL after **every** persistent write and extend instance TTL in `initialize` and in each mutating call, to a clearly named, documented window (threshold + extend-to constants). Implementation tracked in #88.
- Monitor live-until ledgers for the contract instance and hot keys (`TxConsumed`, active `Provider` entries) and alert when TTL drops below the threshold; keep a keeper that can submit `ExtendFootprintTTL` if the contract itself cannot be invoked (e.g. instance archived).
- Record the chosen window (ledgers and seconds) in code comments and tests so auditors can verify it against the network's `min_persistent_entry_ttl` / `max_entry_ttl` parameters.

---

## T4 — Unbounded `list_providers` / `list_payments` calls

| | |
|---|---|
| **Severity** | **High (P1)** |
| **Tracking** | [#91](https://github.com/DonCervantes/x402-Handle/issues/91) (replaces closed #36; open PR [#51](https://github.com/DonCervantes/x402-Handle/pull/51), also [#115](https://github.com/DonCervantes/x402-Handle/pull/115)) |
| **Checklist gate** | Not a named gate in the go-live checklist; must still land before Public per #91 |

**Call path.**

- `list_providers(from_id, to_id)` validates only `from_id != 0 && to_id >= from_id`, then loops `while id <= to_id`, performing a persistent `get` of `DataKey::Provider(id)` for **every** id in the range and pushing misses onto the returned `Vec`.
- `list_payments(provider_id, from_id, to_id)` does the same over `DataKey::Payment(id)`, additionally filtering each hit by `provider_id`.

A caller can pass `from_id = 1, to_id = u64::MAX`; there is no maximum page size.

**Impact.** Denial of service on the read path: the loop exhausts the Soroban instruction/memory budget and the transaction fails with an out-of-budget error rather than data. The indexer's pagination (its intended consumer, per the doc comment on `list_providers`) inherits the same failure when it guesses a bad range, and anyone can burn network fees spamming oversized ranges.

**Mitigation / recommendation.**

- Cap the range (e.g. `MAX_PAGE_SIZE = 100` ids) and panic `Error::InvalidArgument` for oversized ranges so failures are explicit and cheap.
- Document the cap next to the functions and in the indexer's pagination strategy (issue #15 covers indexer-side cursor pagination).
- Add a test proving an oversized range fails closed.

---

## Severity summary

| # | Threat | Severity | Tracking | Checklist gate |
|---|--------|----------|----------|----------------|
| T1 | `log_payment` callable without auth | Critical (P0) | [#8](https://github.com/DonCervantes/x402-Handle/issues/8) | Prerequisite security issues |
| T2 | No pause / admin rotation | High (P1) | [#76](https://github.com/DonCervantes/x402-Handle/issues/76), PR [#63](https://github.com/DonCervantes/x402-Handle/pull/63) | Prerequisite security issues |
| T3 | TTL expiry — no `extend_ttl` anywhere | Critical (P0) | [#88](https://github.com/DonCervantes/x402-Handle/issues/88) | Testnet evidence |
| T4 | Unbounded `list_providers` / `list_payments` | High (P1) | [#91](https://github.com/DonCervantes/x402-Handle/issues/91), PRs [#51](https://github.com/DonCervantes/x402-Handle/pull/51)/[#115](https://github.com/DonCervantes/x402-Handle/pull/115) | — |

**Public verdict:** NO-GO while T1, T2, and T3 remain open or unwaived — exactly the three gates the [go-live checklist](stellar-mainnet-go-live-checklist.md) already tracks. The checklist's written sign-off section remains the single place where a GO decision is recorded; this document only supplies the threat analysis behind those gates.

## Additional observations (out of #87's required scope)

- `initialize(admin)` has no auth and no deployment-time guard beyond the `AlreadyInitialized` panic: whoever calls it first becomes admin. Deployments must initialize atomically with the deployer as admin (noted as a design risk in open PR #55).
- `register_provider` accepts any `payment_token` address and any `endpoint` string — no USDC SAC allowlist, no URL validation (phishing vector; the checklist's *Mainnet configuration* gate covers the allowlist).
- Tests rely on `env.mock_all_auths()` throughout, so no test proves an auth failure (tracked separately from this issue).

## Relationship to other documents

- [Stellar Public mainnet go-live checklist](stellar-mainnet-go-live-checklist.md) — release gate (issue #41, closed, still NO-GO). This threat model links to it and does not replace or duplicate it.
- Open PR [#55](https://github.com/DonCervantes/x402-Handle/pull/55) (`docs/AUDIT-SOROBAN-REGISTRY.md`) — broader method-by-method audit report covering all 13 methods.
- Open PR [#62](https://github.com/DonCervantes/x402-Handle/pull/62) (`docs/soroban-registry-threat-model.md` + audit checklist) — concise audit checklist/threat-model pair from Epic #31.

This document is deliberately narrower than both: it is the focused, severity-rated analysis of the four threats in #87, tied to the go-live checklist's gates, so it can be reviewed and merged independently of the two open audit PRs.
