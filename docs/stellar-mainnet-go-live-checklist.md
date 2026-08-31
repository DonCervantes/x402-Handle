# Stellar Public mainnet go-live checklist

**Issue:** [#41](https://github.com/DonCervantes/x402-Handle/issues/41)
**Scope:** HANDLE Soroban registry on the Stellar Public network
**Status:** **NO-GO** until every required gate below is checked or explicitly waived in the issue and signed off in this document.

This checklist is a release gate, not a deployment runbook. Testnet evidence must be attached before a Public deployment PR is opened. Never put secret keys, seed phrases, or unredacted credentials in this document.

## Written go/no-go sign-off

Complete this section only after the checklist is green or every exception has a written waiver in issue #41.

- Decision: `NO-GO` / `GO`
- Decision date (UTC): `TBD`
- Auditor/reviewer: `TBD`
- Release owner: `TBD`
- Evidence links: `TBD`
- Exceptions and waivers: `None` / `TBD`
- Signature: `TBD`

A Public deployment PR must include a link to this section and must not be merged while the decision is `NO-GO`.

## Required gates

### Prerequisite security issues

- [ ] **Issue #8 — `log_payment` authorization:** closed, or an explicit written waiver is recorded in issue #41. The current contract allows any caller to invoke `log_payment`; this is not acceptable for Public without a documented risk acceptance and mitigation.
- [ ] **Issue #18 — pause and admin transfer:** closed, or an explicit written waiver is recorded in issue #41. The Public deployment must have a tested emergency pause path and a controlled admin rotation policy.

### Testnet evidence

- [ ] Persistent storage TTL extension has been implemented and tested for providers, payment logs, and replay-protection entries.
- [ ] Testnet smoke test completed with recorded transaction hashes, contract ID, network, timestamps, and expected outcomes.
- [ ] The exact release WASM hash was verified independently with `stellar contract inspect` and/or Stellar Expert. Record the command/output or Explorer link below.
- [ ] The smoke-test and inspection evidence is reproducible offline where possible and contains no secrets.

Evidence:

```text
Testnet contract ID: TBD
Testnet deployment transaction: TBD
Smoke-test transactions: TBD
WASM SHA-256: TBD
Inspection command/output or Stellar Expert URL: TBD
```

### Mainnet configuration and operations

- [ ] Admin key is held by hardware-backed signing or an approved multisig policy. No demo secret, plaintext seed, or single-person hot key is used.
- [ ] Circle Public USDC SAC is hardcoded/allowlisted as `payment_token`; arbitrary token addresses are rejected for Public providers.
- [ ] Upgrade policy is decided and documented: immutable WASM, or controlled `UpdateContractWasm` with authorized governance. The current contract has no upgrade path, so an immutable deployment must be treated as permanent unless a new migration contract is approved.
- [ ] Fees and SAC wrapping are documented for the selected payment flow, including whether callers pay classic USDC or the USDC SAC contract.
- [ ] Public contract ID and exact WASM hash are published in the registry README after deployment, in a separate deployment PR with the evidence attached.
- [ ] Incident procedure is documented and tested: how to pause/deactivate providers, revoke or rotate admin authority, and stop middleware calls if `log_payment` is abused.

## Deployment decision record

Do not fill in Public identifiers before the checklist is approved.

- Public contract ID: `TBD — no Public deployment approved`
- Public deployment transaction: `TBD`
- Public WASM hash: `TBD`
- Public network configuration reviewed by: `TBD`
- Incident contact/on-call: `TBD`
- Rollback or containment plan: `TBD`

## Evidence and waiver rules

1. Every checked item must link to a test, transaction, inspection result, design decision, or signed review.
2. A waiver must identify the exact risk, mitigation, owner, expiry/review date, and approving reviewer in issue #41.
3. A checklist item marked `TBD`, `NO-GO`, or missing evidence is a blocking failure.
4. This document deliberately does not authorize a Public deployment by itself; the signed decision and the release PR are separate approvals.
