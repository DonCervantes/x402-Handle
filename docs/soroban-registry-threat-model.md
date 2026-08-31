# Soroban Registry — Threat Model (concise)

Scope: `contracts/soroban-registry` (HANDLE registry on Soroban). Focus: on-chain risks, auth, data availability, and indexer integrity.

Actors
- Admin: single privileged account (can initialize, transfer admin, pause operations).
- Provider owner: account that registers provider entries.
- Logger/Indexer: off-chain components reading events.
- Malicious actor: tries to spoof events, overwrite providers, or spam log_payment.

Assets
- Registry entries (provider metadata)
- Event stream (used by indexer)
- Admin capabilities (pause/transfer)

Threats & Mitigations
- Unauthorized writes: require explicit signer checks for provider CRUD and admin-only ops. Tests must assert signer failure.
- Log spam / event flooding: add rate-limits or require logger allowlist for `log_payment`, or make `log_payment` write minimal data and rely on off-chain filtering.
- Data expiry / TTL loss: ensure stored entries have TTL renewal mechanism (heartbeat or extend on update) or document non-expiry guarantee.
- Admin key compromise: support admin transfer and pause to mitigate; recommend multisig in deployment docs.
- Event schema drift: use stable event names and versions; include schema version field in events.
- Replay / duplicate events: include nonce/timestamp in events and let indexer dedupe by unique identifiers.
- Storage collisions: use namespaced keys and explicit length checks.

Operational Controls
- CI: run `cargo test` and lint; include auth-focused tests.
- Deploy: publish Testnet contract ID and require smoke tests before Mainnet.
- Monitoring: indexer should alert on unexpected event types or high volume spikes.

Open decisions
- `log_payment` public vs allowlist: decide based on product needs; if public, harden for spam and size limits; if restricted, add allowlist and tests.
- TTL semantics: choose between explicit TTL+heartbeat or permanent storage.

Conclusion: prioritize auth tests, TTL handling, and stable events before Testnet deploy.
