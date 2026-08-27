# flovia-escrow — Soroban Escrow Contract (opt-in path)

> Optional on-chain escrow for x402 payments above a provider-defined
> threshold. Companion to `contracts/soroban-registry`, which stays
> **non-custodial** as the default cheap path (issue: "registry stays
> non-custodial for the default cheap path; escrow is opt-in per provider").

**Status: TESTNET ONLY.** Do not deploy to Public before (a) a testnet soak
and (b) an external audit of this contract — it introduces a **new threat
model** (custody of in-flight payments), not just new surface on the registry.

## What it does

- **`initialize(admin, token)`** — one-time setup; pins the single payment
  asset (deploy one escrow per asset; HANDLE uses USDC's SAC).
- **`set_policy(provider, enabled, min_lock_stroops, dispute_window_secs)`** —
  provider **opt-in**, signed by the payout address (the x402 `destination`).
  Providers that never opt in are unaffected: agents keep paying them direct,
  exactly as in v1.
- **`lock(agent, provider, amount_stroops, payment_ref)`** — agent locks USDC
  for one x402 call. Pull payment: the agent first grants the contract a SAC
  allowance (`approve`); `lock` pulls atomically via `transfer_from`.
  `payment_ref` = sha256 of the payment tx hash / challenge id and is unique
  (replay protection, mirroring the registry's `log_payment`).
- **`release(caller, id)`** — provider delivered: the agent acks, or a
  whitelisted **oracle** releases on proof of delivery (covers agents that
  go silent after being served). Only before the deadline.
- **`refund(id)`** — **timeout policy: REFUND TO AGENT** (see below).
  Permissionless: anyone (keeper bots included) can trigger it.
- **`dispute(caller, id)`** — agent or provider opens a dispute before the
  deadline; freezes the escrow.
- **`resolve(caller, id, release_to_provider)`** — admin or oracle adjudicates.
  Disputes are the on-chain input for the off-chain trust score's
  `claimsFactor` (`packages/intelligence/src/trust.ts`) — they replace the
  hard-coded `getDisputeCount() == 0`.
- **Admin ops** — `set_paused(bool)` circuit breaker, `set_oracle(addr, bool)`,
  two-step `set_pending_admin`/`accept_admin`.
- **Reads** — `get_escrow`, `get_escrow_by_ref`, `escrow_count`, `list_escrows`,
  `get_policy`, `is_oracle`, `is_paused`, `admin`, `token`.

## Timeout policy decision: refund to agent

The issue allowed either "release to provider" or "refund to agent" on
timeout, provided one was picked and documented. **We refund the agent.**

Rationale:

1. "No unbounded hold of user funds" is only cryptographically guaranteed if
   the payer can always exit an un-acked escrow.
2. The provider is not defenseless against agents who take the service and
   refuse to ack: the provider asks a whitelisted **oracle to release before
   the deadline** with proof of delivery, or **disputes** and lets the
   admin/oracle rule. Providers that deliver reliably are unaffected.
3. It matches the product promise: refunds become protocol-enforceable
   instead of a social process.

Consequence (documented trade-off): a provider that delivers but neither
obtains an ack/oracle-release nor disputes before the deadline loses that
payment. Providers should size `dispute_window_secs` accordingly (bounded to
`[60s, 30d]`).

## No-unbounded-hold guarantees

| Situation | Guarantee |
| --- | --- |
| Locked, deadline reached | `refund` is permissionless; agent's exit cannot be blocked (works while paused). |
| Disputed, admin absent | Hard cap: permissionless refund at `deadline + MAX_DISPUTE_WINDOW_SECS` (30d). |
| Contract paused | Pause blocks only new `lock`s and `release`s. `refund`, `dispute` and `resolve` keep working — funds can never be frozen indefinitely by the pause switch. |
| Deadline extension | Not supported in v1 — deliberately, since it would reintroduce unbounded holds. |

## State machine

```
                     lock() [agent pulls USDC via SAC allowance]
  ────────────────────────────────► LOCKED ──────────────────────────┐
        release(caller)             │        │        dispute(caller) │
   [agent ack | oracle, <deadline]  │        │   [agent | provider,  │
        │                           │        │    <deadline]         │
        ▼                           │        ▼                       ▼
    RELEASED                        │     REFUNDED ◄─────── DISPUTED ─┘
   (provider paid)                  │   (deadline timeout)   │ resolve() [admin|oracle]
                                    │                        │   release → RELEASED
                                    └────────────────────────┘   refund  → REFUNDED
                                        refund() [permissionless]   (or hard-cap refund
                                                                     at deadline + 30d)
```

Terminal events are emitted exactly once per escrow (`release` xor `refund`).

## Events (consumed by `apps/cli/indexer.ts`)

| Topics | Data | Meaning |
| --- | --- | --- |
| `("escrow", "lock", id)` | `Escrow` | funds locked |
| `("escrow", "release", id)` | `Escrow` | provider paid (ack or oracle) |
| `("escrow", "refund", id)` | `Escrow` | agent refunded (timeout / resolution / hard cap) |
| `("escrow", "dispute", id)` | `Escrow` | dispute opened |
| `("escrow", "resolve", id)` | `Resolution` | dispute ruled (terminal event follows) |
| `("escrow", "policy", provider)` | `ProviderPolicy` | provider opt-in changed |
| `("escrow", "oracle", oracle)` | `bool` | oracle whitelist changed |
| `("escrow", "paused", admin)` | `bool` | circuit breaker toggled |

Every payload carries the **full current `Escrow` struct**, so the indexer can
mirror state idempotently from any single event (out-of-order / re-polls safe).

## Security notes / scope

- The registry contract is **untouched** — v1 stays non-custodial; this is a
  separate contract, so the existing registry audit surface is unchanged.
- The escrow never chooses payees by itself: every exit (`release`/`refund`/
  `resolve`) pays an address stored in the `Escrow` created by the agent.
- `payment_ref` uniqueness prevents double-escrowing one x402 payment.
- One asset per deployment (pinned at `initialize`) — keeps the audit small.
- Oracles are trusted role-players (they can release to providers). Admin is
  trusted (it can resolve). Both are event-logged for accountability.
- Storage rent: escrow/policy entries are persistent and are **not** archived
  in v1 (matching the registry's storage posture). A future version may prune
  terminal escrows once indexers only rely on events.

## Build

```bash
cd contracts/soroban-escrow
cargo build --target wasm32-unknown-unknown --release
# or: stellar contract build
```

## Test (no `mock_all_auths` — issue #34 style)

```bash
cargo test
```

Every test provides authorization explicitly via
`env.mock_auths(&[MockAuth { .. }])` with the exact invocation tree —
including the nested SAC `transfer_from` sub-invocation performed by `lock`.
Any call whose signer is not mocked fails, which is what the negative tests
(provider self-release, third-party disputes, unsigned locks, non-admin
oracle changes) rely on. The real Stellar Asset Contract is used for the
token (minted balances, allowances, real `transfer_from` accounting).

## Deploy (testnet)

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/flovia_escrow.wasm \
  --source <admin-secret> \
  --network testnet

stellar contract invoke \
  --id $ESCROW_CONTRACT_ID \
  --source <admin-secret> \
  --network testnet \
  -- initialize \
     --admin <admin-public-key> \
     --token <usdc-sac-contract-id>
```

Store the contract id as `ESCROW_CONTRACT_ID` in `.env`; the indexer picks it
up automatically (see `apps/cli/indexer.ts`). Setting no
`ESCROW_CONTRACT_ID` keeps the indexer in registry-only mode.

### Provider opt-in (example)

```bash
# 0.005 USDC minimum, 24h dispute window
stellar contract invoke --id $ESCROW_CONTRACT_ID --source <provider-secret> \
  --network testnet -- set_policy \
  --provider <provider-public-key> --enabled true \
  --min_lock_stroops 50000 --dispute_window_secs 86400
```

### Agent flow (x402 call over threshold)

1. Read the provider policy (`get_policy`) — decides escrow vs direct pay.
2. `token.approve(escrow_contract, amount)`.
3. `lock(provider, amount, sha256(tx_hash | challenge_id))`.
4. Consume the paid endpoint; then `release` on delivery, or wait for the
   deadline to `refund` if the provider never delivers/serves.
