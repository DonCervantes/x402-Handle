# Soroban Registry — Audit Checklist

Purpose: concise checklist to make `contracts/soroban-registry` auditable and safe for Testnet → Mainnet deployment.

1. Build & Reproducibility
- Ensure crate builds with pinned Rust toolchain and soroban CLI version.
- Add deterministic build steps and CI job (`cargo build --release`, `cargo test`).

2. Surface-level review
- Confirm contract name and events match README and indexer expectations.
- Remove references to "Flovia" and wrong build path.

3. Access control & auth
- Verify `initialize(admin)` sets a single admin and is callable only once.
- Confirm provider CRUD operations require admin or provider owner as intended.
- Ensure `log_payment` auth matches design: either public (allowed) or restricted to allowlist; add explicit checks and tests.
- Replace `env.mock_all_auths()` in tests with explicit signer-based assertions.

4. State & storage
- Ensure persistent entries have TTL management or explicit non-expiry semantics.
- Add TTL extension on provider update/heartbeat if intended.
- Validate storage keys never collide and are namespace-prefixed.

5. Events & Indexer
- Confirm event names emitted by contract match indexer expectations (`prov_reg`, `pay_log` or agreed names).
- Emit structured events with stable schemas.

6. Safety & invariants
- Check for panic/unwrap paths and replace with controlled errors.
- Validate all inputs (lengths, ranges) and return descriptive error codes.

7. Gas & resource limits
- Ensure operations are bounded in loop/collection sizes.
- Add defensive checks for gas-heavy inputs.

8. Tests
- Add unit tests for auth, admin transfer, pause/unpause, TTL behavior, and event emission.
- Add integration smoke test that runs initialize → register → log_payment and verifies events.

9. Deploy & Migration
- Record deployed contract IDs for Testnet and Mainnet in repo (e.g., `deploy/` or docs).
- Add upgrade plan for contract replacement if needed.

10. Documentation
- Update README with build, test, deploy, and on-chain ID steps.
- Document threat model and audit findings.

Acceptance: all items either implemented or have an owner/PR and CI passing.
