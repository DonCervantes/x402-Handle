# Soroban Audit: flovia-registry Threat Model & Go/No-Go Checklist

> **Internal audit** of `contracts/soroban-registry` (`flovia-registry`) before any Stellar Public network deploy.
> Complements the HANDLE end-to-end audit ([#31](https://github.com/DonCervantes/x402-Handle/issues/31), C6 / [#8](https://github.com/DonCervantes/x402-Handle/issues/8), admin dead / [#18](https://github.com/DonCervantes/x402-Handle/issues/18)).

---

## 1. Scope

### 1.1 In-scope `contractimpl` methods

| # | Method | Auth | Storage access | Notes |
|---|--------|------|----------------|-------|
| M1 | `initialize(admin)` | None (one-shot) | Instance: `Admin`, `ProviderCounter`, `PaymentCounter` | Panics `AlreadyInitialized` if called twice. |
| M2 | `admin()` | None | Instance: `Admin` | Read-only. Panics `NotInitialized` if unset. |
| M3 | `register_provider(owner, name, endpoint, price_stroops, payment_token, metadata_hash, category)` | `owner.require_auth()` | Persistent: `Provider(id)`, Instance: `ProviderCounter` | Returns new `provider_id`. |
| M4 | `update_provider(provider_id, price_stroops, endpoint, metadata_hash)` | `owner.require_auth()` | Persistent: `Provider(id)` | Fields updated: `price_stroops`, `endpoint`, `metadata_hash`, `updated_at`. |
| M5 | `deactivate(provider_id)` | `owner.require_auth()` | Persistent: `Provider(id)` | Sets `active = false`. Emits `prov_off`. |
| M6 | `activate(provider_id)` | `owner.require_auth()` | Persistent: `Provider(id)` | Sets `active = true`. Emits `prov_on`. |
| M7 | `get_provider(provider_id)` | None | Persistent: `Provider(id)` | Read-only. Panics `NotFound`. |
| M8 | `provider_count()` | None | Instance: `ProviderCounter` | Read-only. |
| M9 | `list_providers(from_id, to_id)` | None | Persistent: `Provider(id)` for id in range | **Unbounded loop.** Panics `InvalidArgument` if range invalid. |
| M10 | `log_payment(provider_id, payer, amount, tx_hash)` | **None** | Persistent: `Provider(id)`, `Payment(id)`, `TxConsumed(tx_hash)`, Instance: `PaymentCounter` | Anyone may call. Replay protection via `TxConsumed`. |
| M11 | `get_payment(payment_id)` | None | Persistent: `Payment(id)` | Read-only. Panics `NotFound`. |
| M12 | `payment_count()` | None | Instance: `PaymentCounter` | Read-only. |
| M13 | `list_payments(provider_id, from_id, to_id)` | None | Persistent: `Payment(id)` for id in range | **Unbounded loop.** Filters by `provider_id`. |

### 1.2 `DataKey` variants

| Variant | Storage | Lifetime | TTL behaviour |
|---------|---------|----------|---------------|
| `Admin` | Instance | Permanent (if instance TTL extended) | **No `extend_ttl` call.** |
| `ProviderCounter` | Instance | Permanent | **No `extend_ttl` call.** |
| `PaymentCounter` | Instance | Permanent | **No `extend_ttl` call.** |
| `Provider(u64)` | Persistent | Expiry-dependent | **No `extend_ttl` call.** |
| `Payment(u64)` | Persistent | Expiry-dependent | **No `extend_ttl` call.** |
| `TxConsumed(BytesN<32>)` | Persistent | Expiry-dependent | **No `extend_ttl` call.** |

### 1.3 Event topics

| Topic tuple | Short name | README name | Indexer match |
|-------------|-----------|-------------|---------------|
| `("registry", "prov_reg", id)` | `prov_reg` | `provider_registered` | ✅ matched in `indexer.ts` |
| `("registry", "prov_upd", id)` | `prov_upd` | `provider_updated` | ✅ matched in `indexer.ts` |
| `("registry", "prov_off", id)` | `prov_off` | `provider_deactivated` | ❌ **not handled** by indexer ([#16](https://github.com/DonCervantes/x402-Handle/issues/16)) |
| `("registry", "prov_on", id)` | `prov_on` | *(missing from README)* | ❌ **not handled** by indexer |
| `("registry", "pay_log", provider_id)` | `pay_log` | `payment_logged` | ✅ matched in `indexer.ts` |

### 1.4 Error variants

| Variant | Code | Raised by |
|---------|------|-----------|
| `NotInitialized` | 1 | `admin()` |
| `AlreadyInitialized` | 2 | `initialize()` |
| `Unauthorized` | 3 | *(unused currently — should gate `log_payment` in v2)* |
| `NotFound` | 4 | `get_provider`, `update_provider`, `deactivate`, `activate`, `log_payment`, `get_payment` |
| `PaymentAlreadyLogged` | 5 | `log_payment` duplicate `tx_hash` |
| `InvalidArgument` | 6 | `register_provider` empty name/endpoint; `list_providers`/`list_payments` bad range |

---

## 2. Threat model

### T1 — Forged volume via unauthenticated `log_payment`

| | |
|---|---|
| **Attacker** | Any Stellar account. |
| **Asset** | Volume metrics in Trust Score (consumed by indexer → BFF). |
| **Mechanism** | `log_payment` requires no auth. Caller supplies `payer`, `amount`, `tx_hash`. No Horizon proof verifies the Stellar transaction actually occurred. |
| **Impact** | Trust Score inflation. A provider's volume stats can be fabricated at near-zero cost (Soroban tx fee only). |
| **Severity** | **P0** |
| **Status** | **OPEN** — tracked in [#8](https://github.com/DonCervantes/x402-Handle/issues/8). |
| **Mitigation (planned)** | `require_auth` from provider owner or an allowlisted oracle. Do not trust caller-supplied `amount` without on-chain/Horizon attestation. |

### T2 — Provider spoofing

| | |
|---|---|
| **Attacker** | Any Stellar account with XLM for tx fee. |
| **Asset** | Catalog integrity; end users who route payments to a spoofed `endpoint`. |
| **Mechanism** | `register_provider` allows any `endpoint` URL and any `payment_token` address. No validation that `payment_token` is the actual USDC SAC. A malicious provider can point to a phishing endpoint or register a fake token contract. |
| **Impact** | Users may pay the wrong token or send requests to an attacker-controlled endpoint. The registry becomes a vector for phishing. |
| **Severity** | **P1** |
| **Status** | **OPEN** — no existing issue tracks this directly. |
| **Recommended fix** | Allowlist `payment_token` addresses (Circle USDC SAC per network). Validate `endpoint` is a reachable HTTPS URL (or at minimum, non-empty — partially done). Consider admin approval workflow before a provider appears in `list_providers` results. |

### T3 — Admin takeover / dead admin

| | |
|---|---|
| **Attacker** | N/A (risk is loss of admin access, not adversary). |
| **Asset** | Ability to pause, migrate, or restrict the registry. |
| **Mechanism** | `initialize` is one-shot. There is no `transfer_admin`, no admin-only `pause`/`unpause`, and no mechanism to restrict `log_payment` callers. If the admin key is lost or compromised, the registry is permanently unmanageable. |
| **Impact** | Cannot freeze a compromised registry. Cannot restrict who logs payments. Cannot migrate to a new contract. |
| **Severity** | **P1** |
| **Status** | **OPEN** — tracked in [#18](https://github.com/DonCervantes/x402-Handle/issues/18). |
| **Mitigation (planned)** | Admin-only `pause`/`unpause`. `transfer_admin`. Allowlist for `log_payment` callers. |

### T4 — Persistent storage expiry (no TTL extend)

| | |
|---|---|
| **Attacker** | N/A (risk is passive data loss). |
| **Asset** | Provider listings, payment logs, replay-protection state. |
| **Mechanism** | `Provider`, `Payment`, and `TxConsumed` are written to persistent storage but `extend_ttl` is never called. On Stellar, persistent entries expire after ~120 days (or the default TTL window). Instance keys (`Admin`, counters) also have no explicit TTL management. |
| **Impact** | Providers vanish from the catalog. Payment logs disappear, breaking historical data. Most critically, `TxConsumed` entries expire, allowing the same `tx_hash` to be logged again — **breaking the only on-chain replay guard**. |
| **Severity** | **P0** |
| **Status** | **OPEN** — tracked in [#33](https://github.com/DonCervantes/x402-Handle/issues/33). |
| **Mitigation (planned)** | After every persistent write, `extend_ttl` to a documented window (30+ days). Re-extend on read/write of hot keys (`TxConsumed`, `Provider`). Extend instance TTL on `initialize` and mutating calls. |

### T5 — DoS via unbounded `list_providers` / `list_payments`

| | |
|---|---|
| **Attacker** | Any Stellar account. |
| **Asset** | Contract instruction budget; indexer reliability. |
| **Mechanism** | `list_providers(from_id, to_id)` and `list_payments(provider_id, from_id, to_id)` loop through the entire range in-contract. A large range (e.g. `from_id=1, to_id=100_000`) hits Soroban instruction/memory limits and fails the transaction. |
| **Impact** | DoS on reads. Indexer cannot paginate efficiently. Wasted compute budget. |
| **Severity** | **P1** |
| **Status** | **OPEN** — tracked in [#36](https://github.com/DonCervantes/x402-Handle/issues/36). |
| **Mitigation (planned)** | Cap range (max 50–100 ids per call). Panic `InvalidArgument` for oversized ranges. Document indexer pagination strategy. |

### T6 — Event indexer topic mismatch

| | |
|---|---|
| **Attacker** | N/A (operational risk). |
| **Asset** | Indexer correctness. |
| **Mechanism** | The README documents event names (`provider_registered`, `payment_logged`) but the code uses short symbols (`prov_reg`, `prov_off`, `prov_on`, `pay_log`). The indexer matches the code symbols, so this is currently consistent — but the README is misleading. Additionally, `prov_off` and `prov_on` events are emitted but the indexer does not handle them, so deactivated/reactivated providers are not reflected in Postgres. |
| **Impact** | Deactivated providers remain in the catalog until manually removed. Confusion for auditors or new contributors. |
| **Severity** | **P1** |
| **Status** | **OPEN** — tracked in [#35](https://github.com/DonCervantes/x402-Handle/issues/35) (README alignment) and [#16](https://github.com/DonCervantes/x402-Handle/issues/16) (indexer `prov_off`/`prov_on`). |
| **Mitigation (planned)** | Update README event table to match `symbol_short!` topics. Handle `prov_off`/`prov_on` in indexer. |

### T7 — Replay of `tx_hash` after TTL expiry

| | |
|---|---|
| **Attacker** | Any Stellar account (or the original payer, after waiting). |
| **Asset** | Volume integrity; replay protection. |
| **Mechanism** | `TxConsumed(tx_hash)` has no TTL extension. After the persistent TTL expires (~120 days), the entry is deleted. The same `tx_hash` can then be passed to `log_payment` again, creating a duplicate payment record. |
| **Impact** | Double-counted volume for Trust Score. Undermines the only on-chain deduplication mechanism. |
| **Severity** | **P0** |
| **Status** | **OPEN** — a direct consequence of [#33](https://github.com/DonCervantes/x402-Handle/issues/33). |
| **Mitigation (planned)** | `extend_ttl` on `TxConsumed` writes, with re-extension on reads. Document that `TxConsumed` TTL must exceed the maximum plausible payment frequency window. |

---

## 3. Method-by-method checklist

Every `contractimpl` method and `DataKey` variant is covered below.

### Lifecycle

| Item | Status | Notes |
|------|--------|-------|
| `initialize` panics on double-call | ✅ Verified | `AlreadyInitialized` error. |
| `initialize` does not require auth on `admin` arg | ⚠️ Design risk | Anyone can call `initialize` with any address as admin. Must be deployed atomically with the deployer as admin. |
| `Admin` DataKey readable via `admin()` | ✅ Verified | |
| No `transfer_admin` | ❌ Open | [#18](https://github.com/DonCervantes/x402-Handle/issues/18) |
| No `pause` / `unpause` | ❌ Open | [#18](https://github.com/DonCervantes/x402-Handle/issues/18) |
| Instance TTL on `Admin` / counters | ❌ Open | [#33](https://github.com/DonCervantes/x402-Handle/issues/33) |

### Provider management

| Item | Status | Notes |
|------|--------|-------|
| `register_provider` requires owner auth | ✅ Verified | `owner.require_auth()`. |
| `register_provider` validates non-empty name/endpoint | ✅ Verified | Panics `InvalidArgument`. |
| `register_provider` validates `payment_token` | ❌ Open | No allowlist; any address accepted. T2. |
| `register_provider` validates `price_stroops` | ❌ Open | Accepts 0 (free provider) and arbitrarily large values. |
| `Provider(u64)` TTL extend | ❌ Open | [#33](https://github.com/DonCervantes/x402-Handle/issues/33) |
| `update_provider` requires owner auth | ✅ Verified | `p.owner.require_auth()`. |
| `update_provider` cannot change `owner` | ✅ Verified | `owner` field is immutable after registration. |
| `deactivate` requires owner auth | ✅ Verified | |
| `activate` requires owner auth | ✅ Verified | |
| `deactivate`/`activate` event topics | ✅ Verified | `prov_off`, `prov_on` in code. |

### Reads

| Item | Status | Notes |
|------|--------|-------|
| `get_provider` panics on missing ID | ✅ Verified | |
| `provider_count` returns 0 when uninitialized | ✅ Verified | `unwrap_or(0)`. |
| `list_providers` range validation | ✅ Verified | Panics `InvalidArgument` if `from_id == 0` or `to_id < from_id`. |
| `list_providers` unbounded loop | ❌ Open | [#36](https://github.com/DonCervantes/x402-Handle/issues/36) |

### Payment log

| Item | Status | Notes |
|------|--------|-------|
| `log_payment` requires provider to exist | ✅ Verified | Panics `NotFound`. |
| `log_payment` replay protection | ✅ Verified | `TxConsumed(tx_hash)` check. |
| `log_payment` requires auth | ❌ Open | Anyone may call. [#8](https://github.com/DonCervantes/x402-Handle/issues/8) |
| `log_payment` validates `amount` | ❌ Open | Caller-supplied `amount` is stored as-is. T1. |
| `log_payment` validates `payer` is a real address | ⚠️ Partial | `Address` type ensures valid format, but no on-chain ownership check. |
| `TxConsumed` TTL extend | ❌ Open | [#33](https://github.com/DonCervantes/x402-Handle/issues/33) → [#37](https://github.com/DonCervantes/x402-Handle/issues/37) (replay after expiry). |
| `Payment(u64)` TTL extend | ❌ Open | [#33](https://github.com/DonCervantes/x402-Handle/issues/33) |
| `PaymentCounter` instance TTL | ❌ Open | [#33](https://github.com/DonCervantes/x402-Handle/issues/33) |
| `get_payment` panics on missing ID | ✅ Verified | |
| `payment_count` returns 0 when uninitialized | ✅ Verified | |
| `list_payments` range validation | ✅ Verified | |
| `list_payments` unbounded loop | ❌ Open | [#36](https://github.com/DonCervantes/x402-Handle/issues/36) |

### Tests

| Item | Status | Notes |
|------|--------|-------|
| Tests use `mock_all_auths` | ⚠️ Gap | No real auth enforcement proof. [#34](https://github.com/DonCervantes/x402-Handle/issues/34) |
| Negative auth tests (non-owner update/deactivate) | ❌ Missing | [#34](https://github.com/DonCervantes/x402-Handle/issues/34) |
| Double `initialize` test | ❌ Missing | [#34](https://github.com/DonCervantes/x402-Handle/issues/34) |
| `cargo test` in CI | ❌ Missing | [#22](https://github.com/DonCervantes/x402-Handle/issues/22) |

---

## 4. Go / No-Go

### Testnet

| Criterion | Status | Blocker? |
|-----------|--------|----------|
| Contract compiles to WASM | ✅ Build succeeds | — |
| Unit tests pass | ✅ `cargo test` green (with `mock_all_auths`) | — |
| `register_provider` → `get_provider` works | ✅ Verified in test | — |
| `log_payment` duplicate rejection works | ✅ Verified in test | — |
| `TxConsumed` TTL not implemented | ❌ Open [#33](https://github.com/DonCervantes/x402-Handle/issues/33) | **Soft block** — acceptable for short-lived Testnet, but data will expire. |
| `log_payment` unauthenticated | ❌ Open [#8](https://github.com/DonCervantes/x402-Handle/issues/8) | **Soft block** — acceptable for Testnet smoke test. |
| No admin pause | ❌ Open [#18](https://github.com/DonCervantes/x402-Handle/issues/18) | **Soft block** — acceptable if admin key is secured and contract can be redeployed. |
| Real auth tests | ❌ Open [#34](https://github.com/DonCervantes/x402-Handle/issues/34) | **Soft block** — acceptable for Testnet but not for audit sign-off. |
| Indexer handles `prov_off`/`prov_on` | ❌ Open [#16](https://github.com/DonCervantes/x402-Handle/issues/16) | **Soft block** — deactivated providers stay in catalog. |
| README / event topic alignment | ❌ Open [#35](https://github.com/DonCervantes/x402-Handle/issues/35) | No — cosmetic. |

**Testnet verdict: GO (soft)**

The contract can be deployed to Testnet for smoke testing ([#38](https://github.com/DonCervantes/x402-Handle/issues/38), [#40](https://github.com/DonCervantes/x402-Handle/issues/40)). The open items above are acceptable risks for a short-lived Testnet deploy that will be redeployed. The admin key must be securely managed, and the deployer must be the initial admin to prevent immediate takeover.

### Public (mainnet)

| Criterion | Status | Blocker? |
|-----------|--------|----------|
| `log_payment` authenticated (oracle or provider owner) | ❌ Open [#8](https://github.com/DonCervantes/x402-Handle/issues/8) | **BLOCKER** — unauthenticated volume is the core trust flaw. |
| Persistent TTL extends on all writes | ❌ Open [#33](https://github.com/DonCervantes/x402-Handle/issues/33) | **BLOCKER** — data expiry breaks replay protection and catalog. |
| Admin pause / unpause | ❌ Open [#18](https://github.com/DonCervantes/x402-Handle/issues/18) | **BLOCKER** — no incident response path if `log_payment` is abused. |
| `transfer_admin` | ❌ Open [#18](https://github.com/DonCervantes/x402-Handle/issues/18) | **BLOCKER** — dead admin key = permanent loss of control. |
| `list_providers` / `list_payments` capped page size | ❌ Open [#36](https://github.com/DonCervantes/x402-Handle/issues/36) | **BLOCKER** — DoS vector on public network. |
| Real auth tests (no `mock_all_auths`) | ❌ Open [#34](https://github.com/DonCervantes/x402-Handle/issues/34) | **BLOCKER** — audit evidence gap. |
| Admin key on hardware / multisig | ❌ Not started | **BLOCKER** — demo secrets must not be used on mainnet. |
| Circle USDC SAC allowlisted as `payment_token` | ❌ Not started | **BLOCKER** — prevents spoofing via fake token contracts. |
| Upgrade policy documented (immutable vs `UpdateContractWasm`) | ❌ Not started | **BLOCKER** — no upgrade path currently exists. |
| Indexer handles `prov_off`/`prov_on` | ❌ Open [#16](https://github.com/DonCervantes/x402-Handle/issues/16) | **High** — deactivated providers shown as active in catalog. |
| README / event topic alignment | ❌ Open [#35](https://github.com/DonCervantes/x402-Handle/issues/35) | No — cosmetic. |
| Testnet smoke with recorded txs | ❌ Not started [#40](https://github.com/DonCervantes/x402-Handle/issues/40) | **High** — must prove end-to-end flow before mainnet. |
| WASM hash verified (`stellar contract inspect`) | ❌ Not started | **High** — must match deployed binary. |
| Contract ID + WASM hash published in README | ❌ Not started | **High** — transparency for consumers. |
| `cargo test` in CI | ❌ Open [#22](https://github.com/DonCervantes/x402-Handle/issues/22) | **High** — regression safety. |

**Public verdict: NO-GO**

Do **not** deploy to Public/Mainnet until **all BLOCKERs above are closed or explicitly waived** with a written risk acceptance. The three mandatory gates are:

1. **[#8](https://github.com/DonCervantes/x402-Handle/issues/8)** — `log_payment` must require auth.
2. **[#33](https://github.com/DonCervantes/x402-Handle/issues/33)** — persistent TTL must be extended.
3. **[#18](https://github.com/DonCervantes/x402-Handle/issues/18)** — admin pause/transfer must be implemented.

See also the mainnet go-live checklist in [#41](https://github.com/DonCervantes/x402-Handle/issues/41).

---

## 5. What a third-party auditor would still need

1. **Formal invariants** — Document contract-level invariants (e.g. "every `Provider` in persistent storage has an `owner` that has not been revoked", "every `TxConsumed` entry corresponds to exactly one `Payment`", "counters are monotonically increasing and never decrease").

2. **Fuzz testing** — Property-based / fuzz tests for:
   - Random `from_id`/`to_id` ranges in `list_providers`/`list_payments` (including edge cases: 0, `u64::MAX`, overlapping ranges).
   - Random `tx_hash` values in `log_payment` to verify uniqueness enforcement.
   - `initialize` called with various admin addresses.
   - Concurrent `register_provider` calls (Soroban transaction ordering).

3. **Upgrade policy** — The contract currently has **no upgrade path** (`UpdateContractWasm`). Decide and document:
   - Immutable (deploy new contract, migrate off-chain data).
   - Upgradable via `UpdateContractWasm` (requires admin signature + WASM hash).
   - This decision affects the admin key lifecycle and incident response.

4. **Soroban SDK version pinning** — `soroban-sdk = "21.7.6"` is pinned but should be verified against the latest stable release and the target Stellar network's protocol version.

5. **Event schema versioning** — The event topics use fixed symbols (`prov_reg`, `prov_upd`, etc.). If the contract is upgraded, event schemas may change. Document the versioning strategy for the indexer.

6. **Network-specific USDC SAC addresses** — Testnet and Public USDC SAC addresses must be documented and verified against Circle's official deployment.

7. **Gas budget analysis** — Document the worst-case instruction count for `list_providers` and `list_payments` at the proposed cap (50/100 ids). Verify it stays within Soroban limits.

8. **Incident response runbook** — How to pause the contract, how to rotate admin, what happens if `log_payment` is abused before #8 is closed, and communication plan for downstream consumers (indexer, BFF, frontend).

---

## 6. Issue cross-reference

| Threat / finding | Issue | Priority | Status |
|-----------------|-------|----------|--------|
| Forged volume — `log_payment` unauthenticated | [#8](https://github.com/DonCervantes/x402-Handle/issues/8) | P0 | OPEN |
| Admin dead — no `transfer_admin` or pause | [#18](https://github.com/DonCervantes/x402-Handle/issues/18) | P1 | OPEN |
| Persistent TTL — storage expires silently | [#33](https://github.com/DonCervantes/x402-Handle/issues/33) | P0 | OPEN |
| Replay after TTL expiry of `TxConsumed` | [#33](https://github.com/DonCervantes/x402-Handle/issues/33) | P0 | OPEN |
| Unbounded `list_providers` / `list_payments` | [#36](https://github.com/DonCervantes/x402-Handle/issues/36) | P1 | OPEN |
| README event names vs code topics | [#35](https://github.com/DonCervantes/x402-Handle/issues/35) | P1 | OPEN |
| Indexer missing `prov_off` / `prov_on` | [#16](https://github.com/DonCervantes/x402-Handle/issues/16) | P1 | OPEN |
| `mock_all_auths` in tests | [#34](https://github.com/DonCervantes/x402-Handle/issues/34) | P0 | OPEN |
| `cargo test` not in CI | [#22](https://github.com/DonCervantes/x402-Handle/issues/22) | P1 | OPEN |
| Provider spoofing — no `payment_token` allowlist | *(new — see T2 above)* | P1 | OPEN |
| Mainnet go-live checklist | [#41](https://github.com/DonCervantes/x402-Handle/issues/41) | P0 | OPEN |
| Epic — audit + Stellar deploy | [#31](https://github.com/DonCervantes/x402-Handle/issues/31) | P0 | OPEN |

---

*Generated as part of the soroban-registry internal audit — [issue #32](https://github.com/DonCervantes/x402-Handle/issues/32).*
