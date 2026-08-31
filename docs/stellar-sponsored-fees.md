# Sponsored Stellar fees for USDC-only agents

**Issue:** [#44](https://github.com/DonCervantes/x402-Handle/issues/44)
**Status:** design and policy layer only; disabled by default

## Proposed transaction path

Use classic Stellar fee-bump transactions for the current USDC payment flow:

1. The agent creates and signs the inner transaction containing only the approved USDC payment and the exact 402 challenge memo.
2. The sponsor verifies the signed inner transaction against the challenge before signing anything.
3. The sponsor creates and signs the outer fee-bump transaction, paying the XLM fee.
4. The sponsor submits the fee-bump transaction and records the sponsored fee separately from the protocol payment.

Soroban authorization and SAC wrapping are not interchangeable with classic fee-bump. A separate design is required if the payment path moves into Soroban contract calls.

## Safety requirements

Sponsorship must be opt-in and disabled by default. It must remain disabled on Stellar Public until issues #2–#4 provide challenge binding and issue #6's drain-risk controls are reviewed.

The sponsor service must enforce:

- sponsor account selected by configuration, preferably hardware-backed or multisig
- daily cap with atomic accounting and a kill-switch
- per-provider allowlist
- Testnet/Public network separation
- exact challenge binding: destination, USDC issuer, amount, memo, network, and expiry
- one approved payment operation only; reject extra operations and unexpected signatures
- agent has sufficient USDC; sponsorship only covers XLM network fees
- independent metrics for sponsored XLM fees, USDC collected, rejected requests, and remaining cap
- audit logs without private keys, seed phrases, or raw sensitive payloads

`packages/x402-stellar/src/sponsorship.ts` contains the pure policy layer. It deliberately does not sign, submit, or persist transactions.

## Testnet acceptance test

Record all identifiers and evidence in the issue before enabling the feature:

- sponsor account and policy configuration (no secret material)
- provider allowlist and daily cap
- agent account with zero XLM and enough USDC
- issued 402 challenge
- inner transaction hash and fee-bump transaction hash
- Horizon confirmation showing the USDC payment and sponsor-paid fee
- delivered resource response
- metrics showing sponsored fee versus collected protocol fee
- kill-switch test showing subsequent sponsorship is rejected
- cap exhaustion test showing the boundary is enforced

## Public launch gate

No Public sponsorship rollout is approved by this document. The Stellar Public go-live checklist must be green, challenge binding must be complete, and the operational/security review must explicitly approve the sponsor implementation.
