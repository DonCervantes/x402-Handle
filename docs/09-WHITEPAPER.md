# Flovia Stellar — White Paper

**Version:** 0.1 (Draft, Hackathon SCF)
**Date:** 2026
**Author:** DonCervantes

---

## Abstract

We introduce **Flovia**, an intelligence and reputation layer for the agentic payments economy built natively on the Stellar network. Flovia addresses a gap that emerges with the convergence of three trends: autonomous AI agents capable of executing actions, low-cost programmable stablecoin payments (USDC on Stellar), and the rise of pay-per-use specialized APIs. While Stellar provides the ideal payment primitive for machine-to-machine commerce, no existing system enables agents to **discover, evaluate, and select** providers in a way that is verifiable, transparent, and composable. Flovia closes this gap with seven integrated layers: payment discovery, identity, KYB verification, financial intelligence, on-chain reputation (Trust Score), AI-driven recommendations, and an agent-facing API.

This paper outlines the protocol design (including an HTTP 402 "x402-Stellar" variant), the on-chain registry powered by Soroban smart contracts, the Trust Score formula, and the architecture of the intelligence and recommendation engine.

---

## 1. Introduction

### 1.1 The Emergence of Agentic Payments

Until recently, payments on the internet have been an essentially human-mediated activity. Even when automated (subscriptions, recurring transfers), a human authorized the relationship up front. Three developments are now changing this:

1. **Capable autonomous agents.** Large Language Models (LLMs) with structured tool use (function calling, the Model Context Protocol [MCP], Computer Use APIs) can plan and execute multi-step tasks involving external services. These agents increasingly need to pay for the services they consume.
2. **Programmable, low-cost stablecoins.** USDC on Stellar offers ~$0.00001 transaction fees and 5-second finality. This makes micropayments (sub-cent) economically viable for the first time.
3. **API-shaped services.** A growing portion of useful internet capability is delivered through narrow, specialized APIs (real-time FX, sentiment analysis, embeddings, geo lookups, etc.). These services lend themselves to pay-per-call rather than subscription billing.

The intersection of these three is the **agentic payments economy**: machines paying machines, in stablecoins, at scale, with little or no human intervention per transaction.

### 1.2 The Trust Gap

The payment primitive — moving USDC from agent to provider on Stellar — is solved. What is not solved is the **decision** that precedes the payment:

- Which providers exist for a given need?
- What is the right price?
- Is the destination account legitimate? Has it undergone KYB?
- Has the provider performed reliably in the past?
- Among candidates, which is the best fit for this specific agent's policy (budget, latency, compliance)?

Today, an autonomous agent on Stellar has no native way to answer these. The information exists in fragments — across Horizon's transaction history, anchor directories, Soroban contract state, public domain registries — but no system aggregates and interprets them into a single decision-grade signal.

### 1.3 Contribution

Flovia provides this missing layer. The contributions of this paper are:

1. A specification for **x402-Stellar**, a variant of the HTTP 402 ("Payment Required") protocol that uses Stellar payments as settlement.
2. A **Soroban smart contract** that serves as the on-chain registry of providers and as a tamper-evident log of payments, enabling composable reputation.
3. A transparent, deterministic **Trust Score** formula based on observable on-chain and verifiable off-chain inputs.
4. An **agent-facing API and SDK** that exposes discovery, recommendation, and payment execution in one cohesive interface.

---

## 2. The x402-Stellar Protocol

### 2.1 Background

HTTP 402 ("Payment Required") has existed in the HTTP specification since the original RFC but has been reserved without standardized semantics. Recent proposals (notably from Coinbase) have revived it as the vehicle for crypto-settled per-request payments on the web. x402 is **settlement-layer agnostic**: it defines a challenge-response protocol, while the actual payment can be settled on any chain. We define here the Stellar-specific binding.

### 2.2 Challenge

A protected resource responds to an unpaid request with HTTP 402 and a JSON challenge:

```json
{
  "version": "x402-stellar-1",
  "network": "testnet" | "public",
  "asset": { "code": "USDC", "issuer": "<G...>" },
  "amount": "0.005",
  "destination": "<G...>",
  "memo": "<unique challenge id>",
  "expires_at": "<ISO-8601>"
}
```

The `memo` field is critical: it ensures that each challenge is uniquely identifiable, enabling idempotency and preventing replay.

### 2.3 Response

The client (agent) constructs a Stellar `Payment` operation matching the challenge, signs it with its source account, and submits it to Horizon. Upon confirmation (~5 seconds), the client retries the original request with header:

```
X-PAYMENT: <transaction hash>
```

### 2.4 Verification

The protected resource's middleware:
1. Fetches the transaction from Horizon by hash.
2. Verifies: `memo` matches challenge, destination matches, asset matches (USDC + issuer), amount ≥ challenge amount, transaction `successful: true`.
3. Checks that the transaction hash has not been consumed for any prior challenge (replay protection).
4. Optionally invokes the `log_payment` function on the Flovia Soroban registry to record the payment on-chain.
5. Serves the resource.

### 2.5 Design choices

- **Memo-based idempotency.** Stellar transactions natively carry a memo field, which we co-opt as the challenge identifier. This means the verification can be done purely from on-chain data, with no external state coordination.
- **USDC only (v1).** Restricting to a single asset eliminates ambiguity for agents and reflects the practical reality of agentic transactions, where stablecoin denomination is desired.
- **Strict by default.** Overpayment is accepted; underpayment is rejected. Behavior is configurable per provider.

---

## 3. The Soroban Registry Contract

### 3.1 Purpose

The registry serves three goals:
1. Provide a canonical, on-chain source of truth for "which providers exist."
2. Tie each provider to a Stellar account that controls it, enabling identity attestations.
3. Optionally log payments to provide an immutable activity record beyond what Horizon offers.

### 3.2 Storage

```rust
struct Provider {
  owner: Address,
  name: String,
  endpoint: String,
  price_stroops: u64,
  payment_token: Address,
  metadata_hash: BytesN<32>,
  created_at: u64,
  active: bool,
}

struct PaymentLog {
  provider_id: u64,
  payer: Address,
  amount: u64,
  tx_hash: BytesN<32>,
  timestamp: u64,
}
```

### 3.3 Functions

| Function | Auth | Effect |
|---|---|---|
| `register_provider(owner, name, endpoint, price, token, metadata_hash)` | `owner.require_auth()` | Inserts a new provider, emits `provider_registered` event |
| `update_provider(id, ...)` | owner of provider | Updates mutable fields |
| `deactivate(id)` | owner of provider | Sets `active = false` |
| `log_payment(provider_id, payer, amount, tx_hash)` | open (anyone can attest) | Inserts a `PaymentLog` if not duplicate, emits `payment_logged` |
| `get_provider(id)` | read | Returns provider |
| `list_providers()` | read | Returns list of providers (max page size 100) |

### 3.4 Trust assumptions

`log_payment` is callable by anyone, but the function validates that the supplied `tx_hash` corresponds to a real payment on Stellar matching the provider's expected destination and asset. In v1, this check is performed off-chain by the Flovia indexer and only attested on-chain. In future versions, we plan to integrate Soroban's cross-contract calls to a payment verification oracle, or move to a model where the provider's middleware itself submits the log call as part of serving the response.

---

## 4. The Trust Score

### 4.1 Goals

We want a score that is:
- **Deterministic and reproducible.** Given the same inputs, anyone can compute the same score.
- **Transparent.** The breakdown is visible in the UI; users see exactly why a score is what it is.
- **Resilient to gaming.** Each input is hard to fake cheaply.
- **Composable.** Can be improved over time without breaking integrations.

### 4.2 Formula (v1)

```
TrustScore = round(100 · (w₁·age + w₂·volume + w₃·kyb + w₄·claims + w₅·recency))

age      = min(1, days_since_registered / 90)              w₁ = 0.15
volume   = min(1, log₁₀(usdc_volume_30d + 1) / 4)          w₂ = 0.30
kyb      = { verified: 1.0, pending: 0.3, none: 0.0 }      w₃ = 0.30
claims   = 1 - min(1, disputes_count / payments_count)     w₄ = 0.15
recency  = { 7d: 1.0, 30d: 0.5, older: 0.0 }               w₅ = 0.10
```

### 4.3 Properties

- A brand-new provider with no KYB, no volume, no history scores ~0.
- A 90+ day provider with KYB tier 2, $10k+ monthly volume, no disputes, recent activity scores ~95-100.
- A provider with KYB but zero volume scores ~45 (the KYB component anchors them, but they need to prove operation to reach high scores).
- A provider can never reach 100 without KYB.

### 4.4 Roadmap for v2

- **Machine learning re-weighting.** Train weights using outcomes data (which providers actually fulfilled vs. caused disputes).
- **Subjective claims.** Allow other Stellar accounts (especially anchors or other high-Trust providers) to publish signed attestations.
- **Slashing.** Bond requirement to register; bond can be slashed by dispute resolution.

---

## 5. The Agent Interface

### 5.1 The SDK

Agents integrate through the `@flovia/agent-sdk` package. The primary entry point:

```ts
const flovia = new Flovia({ secret: env.AGENT_SECRET, network: "public" });

const result = await flovia.discoverAndCall({
  need: "fx-rates",
  maxPrice: 0.01,
  kybRequired: true,
  payload: { pair: "EUR/USD" },
});
```

This single call performs: discovery, recommendation, payment construction, signing, submission, verification, and consumption.

### 5.2 The recommendation engine

The `/api/recommend` endpoint:
1. Filters candidate providers from the registry using the agent's constraints.
2. Computes a composite match score combining Trust Score, price fit, and category match.
3. Passes the top candidates to Claude with a structured prompt, asking for a top-N ranking with reasoning.
4. Returns the JSON to the agent.

The LLM is used for reasoning and explanation, not as the sole arbiter — the underlying scoring is deterministic.

---

## 6. Architecture summary

(See `02-TRD.md` and `05-BACKEND-ESQUEMATICO.md` for component-level detail.)

Flovia is a **Bun monorepo** with five logical packages: `contracts` (Zod data types), `sources` (Stellar SDK clients), `intelligence` (Trust Score, ranker, AI), three applications (`bff`, `frontend`, `cli/indexer`), and a Postgres datastore. The off-chain stack is stateless and reconstructible from the on-chain registry plus Horizon's transaction history at any time.

---

## 7. Security considerations

- **Replay protection.** Memo-based challenge IDs combined with consumed-hash cache prevent replay.
- **Key management.** Agent secrets live in `.env` for the hackathon; production guidance is to use HSM or per-call passkey signing.
- **Verification source of truth.** Always Horizon, never client-supplied transaction data.
- **Reentrancy.** N/A in v1 (no on-chain payment dispatch from the registry).
- **Denial of service on `log_payment`.** Mitigated by per-provider rate limiting and minimum-fee.
- **Trust Score manipulation.** Volume can be self-funded (a provider could pay itself); mitigated in v2 by counting only distinct payer accounts above an age threshold.

---

## 8. Comparison with related work

| System | Cadena | Foco | Diferencia con Flovia |
|---|---|---|---|
| x402 (Coinbase) | EVM, multi | Protocolo de pago | Define protocolo; Flovia agrega inteligencia + KYB. |
| HitPay MPP | Multi | B2B billing | Distinto modelo (suscripciones); no Stellar-native. |
| Chainalysis | Multi | Compliance enterprise | Datos forenses; no agent-facing. |
| Stellar Anchor Directory | Stellar | Listado de anchors | Static directory; no scoring ni para providers de APIs. |

Flovia es complementario a x402 (lo implementa) y a anchors (los consume como fuente de KYB).

---

## 9. Roadmap

| Periodo | Hitos |
|---|---|
| **Hackathon SCF** | Demo testnet, contrato deployado, 5 providers, playground |
| **Mes 1-3** | Mainnet, 50+ providers, 1-2 anchors integrados, SDK en npm |
| **Mes 4-9** | API Pro comercial, scoring v2, 3 clientes Enterprise |
| **Mes 10-18** | Disputes resolution, insurance pool, expansión a anchor partners globales |
| **Año 2+** | Federación con sistemas equivalentes en otras cadenas (puente, no fork) |

---

## 10. Conclusion

The agentic payments economy is not hypothetical — it is being built right now, one tool-using LLM at a time. The friction today is not in moving money, but in deciding *who* to move it to. Stellar, with USDC native, sub-second finality, and a regulated anchor ecosystem, is the natural settlement layer for this economy. Flovia is the intelligence layer that makes it usable. We invite the Stellar community to build with us, on the registry that is already deployed and the SDK that already works.

---

## Appendix A — Bibliografía y referencias

- Stellar Soroban documentation — https://developers.stellar.org/docs/soroban
- USDC on Stellar — https://www.circle.com/en/multi-chain-usdc/stellar
- HTTP 402 protocol discussion — RFC 9110 §15.5.2
- SEP-10 (Stellar Web Auth) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
- SEP-12 (KYC API) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
- Anchor Directory — https://resources.stellar.org/anchors

## Appendix B — Glosario

(Ver `01-PRD.md` § 10.)
