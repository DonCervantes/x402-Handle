# Soroban registry TTL runbook

**Issue:** [#88](https://github.com/DonCervantes/x402-Handle/issues/88)
**Scope:** `contracts/soroban-registry/src/lib.rs` (contract `FloviaRegistry`)
**Companion documents:** [Stellar Public mainnet go-live checklist](stellar-mainnet-go-live-checklist.md) → *Testnet evidence* → "Persistent storage TTL extension has been implemented and tested for providers, payment logs, and replay-protection entries." The broader threat analysis lives in issue [#87](https://github.com/DonCervantes/x402-Handle/issues/87).

## Chosen TTL window

Defined once in `contracts/soroban-registry/src/lib.rs` as `TTL_THRESHOLD` / `TTL_EXTEND_TO` (Stellar ledgers ≈ 5 s → 17_280 ledgers ≈ 1 day):

| Constant | Ledgers | Time | Seconds | Meaning |
|---|---|---|---|---|
| `TTL_THRESHOLD` | 120_960 | 7 days | 604_800 | Extend only when fewer than this many ledgers remain |
| `TTL_EXTEND_TO` | 518_400 | 30 days | 2_592_000 | The window every entry is topped up to |

Reference network parameters (Public and the test environment): new persistent/instance entries start at `min_persistent_entry_ttl` = 4096 ledgers (≈ 5.7 h); any single extension is capped by `max_entry_ttl` = 6_312_000 ledgers (≈ 365 days), so 518_400 ledgers is always within budget.

## Where the TTL is extended

- `initialize` → contract instance entry (covers `Admin`, `ProviderCounter`, `PaymentCounter`, and the WASM code entry).
- `register_provider` → `Provider(id)` + instance.
- `update_provider`, `deactivate`, `activate` → `Provider(id)` + instance.
- `log_payment` → `Payment(counter)`, `TxConsumed(tx_hash)` + instance.
- Read-only calls (`get_provider`, `get_payment`, `list_*`, `admin`, `*_count`) intentionally do **not** extend TTL — they cost nothing, but they also do not keep entries alive.

## Monitoring

- Alert when `live_until_ledger − current_ledger < 120_960` for the contract instance entry and for hot persistent keys (`TxConsumed(*)`, active `Provider(*)`). Readable via Stellar RPC `getLedgerEntries` or Stellar Expert.
- Operational goal: every entry is touched by a mutating call at least once every ~23 days (30-day window minus the 7-day threshold).

## If a TTL is missed

Nothing happens on day 31 of silence by itself — the danger starts when an entry's TTL reaches 0:

1. **The entry is archived (persistent and instance keys).** It is not deleted: an archived persistent entry can only be removed by restoring it first, never re-created behind the contract's back.
2. **Transactions touching it misbehave.** A transaction that has an archived key in its footprint without a restore list fails during apply, before the contract runs — so `get_provider`/`list_providers` fail, `log_payment` fails before its `PaymentAlreadyLogged` check can answer, and clients see footprint errors instead of clean contract errors. With normal simulation (Protocol 23+) the entry is auto-restored first, which succeeds but bills restoration fees on top of rent.
3. **Replay protection degrades.** `TxConsumed(tx_hash)` is only guaranteed while it sits live on-ledger. Once archived, replay protection depends on paid restoration at access time; if the marker entry is ever removed (restore-then-delete, or any off-contract ledger event), the same `tx_hash` can be logged again and volume double-counts — the exact scenario #88 was filed for.
4. **The catalog empties.** Archived `Provider(id)` entries disappear from reads until restored, so the registry silently looks empty to the indexer and the BFF. Archived `Payment(id)` entries break historical queries.
5. **If the instance entry (or WASM code) archives, the contract is down entirely** — every call fails until both are restored.

### Recovery steps

1. **Detect:** query `live_until_ledger` for the instance and key entries; the monitoring alert above should fire at 120_960 ledgers remaining, not at 0.
2. **Restore if archived:** include the entry in the transaction's restore list (normal simulation does this automatically) or submit `RestoreFootprintOp`. Restored entries only receive the network **minimum** TTL (~4095 ledgers ≈ 5.7 h).
3. **Re-extend immediately:** invoke one mutating call per contract (owner-signed `activate`/`update_provider`, or a `log_payment`) so the contract's own `extend_ttl` raises entries back to 518_400 ledgers (30 days). Alternatively submit `ExtendFootprintTTL` with the keys in the read-only footprint — TTL extension is permissionless and does not require invoking the contract.
4. **Verify:** re-read `live_until_ledger` for instance + `Provider`/`Payment`/`TxConsumed` keys and confirm the counters and `Admin` are intact (they live in the instance entry).
5. **Follow up:** record the incident, fix the keeper/monitoring gap, and re-check the TTL gate in the go-live checklist before any Public deploy.

### Prevention

Keep a keeper that submits a benign mutating call (or `ExtendFootprintTTL`) at least once every 23 days per entry, and treat the 7-day threshold as the alerting line — the 30-day window is the buffer, not the schedule.
