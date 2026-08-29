# HANDLE provider registration

> Public spec for registering a paid API/resource in HANDLE's on-chain provider
> registry and discovery layer. Read this before asking "how do I get indexed."

## Scope: Stellar only

HANDLE's provider registry and discovery layer index **Stellar-settled,
native-USDC x402 endpoints only**:

- Soroban smart contracts for the on-chain registry (`contracts/soroban-registry`)
- Native USDC on Stellar (testnet or public) as the only settlement asset
- x402 challenges over the Stellar network (the `x402-stellar-1` protocol —
  see `packages/x402-stellar`)

EVM chains (Base, Polygon, etc.) and Solana are **out of scope**. There is no
multi-chain roadmap item today. This matches what the landing page FAQ already
tells end users (`apps/frontend/app/landing-copy.ts`):

> "Does HANDLE support other chains? Not during this hackathon. HANDLE is 100%
> Stellar — Soroban smart contracts, native USDC, and x402 over the Stellar
> network. No EVM, no Solana, no multi-chain."

This document makes that scope explicit for third-party integrators, not just
landing-page visitors.

## Two different things named "discovery" — don't confuse them

1. **`GET /aeo/x402`** (`apps/bff`) — a read-only mirror of *external* x402
   Bazaar-style registries (CDP Discovery, Dexter, PayAI — see
   `apps/bff/data/x402-discovery/*.json`). This exists for HANDLE's own market
   intelligence. It is **not a submission endpoint** — it only reflects what
   CDP/Dexter/PayAI already indexed on Base/Solana, none of which is Stellar,
   and there is no way to add an entry to it by request.
2. **The HANDLE provider registry** (`contracts/soroban-registry`, indexed by
   `apps/cli/indexer.ts`, exposed read-only at `GET /stellar/providers`) — the
   actual self-serve registry Stellar providers register into. This document
   describes how to register here.

If you found HANDLE through the Base/Solana entries under (1) and want to be
listed, see the FAQ below for why that isn't possible today.

## Registration format

A HANDLE listing has three parts that must all agree with each other: the
on-chain registry entry, your endpoint's `.well-known/x402-discovery`
metadata, and the payment account your x402 middleware actually pays out to.

### 1. On-chain registry entry

Call `register_provider` on the deployed `FloviaRegistry` Soroban contract
(`REGISTRY_CONTRACT_ID` in `.env.example`; testnet only today — see
`contracts/soroban-registry/README.md` for deploy/invoke commands):

| Field | Type | Notes |
| --- | --- | --- |
| `owner` | `Address` | Stellar `G...` account; must sign the registration (`require_auth`) and is the only account that can later update/deactivate the listing |
| `name` | `String` | Display name |
| `endpoint` | `String` | HTTPS URL of the paid resource; must match `resource` in your `.well-known/x402-discovery` metadata |
| `price_stroops` | `u64` | Price per call in stroops of USDC (1 USDC = 10,000,000 stroops) |
| `payment_token` | `Address` | Soroban contract address of the USDC asset you accept |
| `metadata_hash` | `BytesN<32>` | Hash of your extended off-chain metadata (e.g. your `.well-known/x402-discovery` payload) — keeps on-chain storage cheap |
| `category` | `Symbol` | Free-form, lowercase, ASCII, ≤32 chars (Soroban `Symbol` limit) — see Categories below |

Returns a `provider_id`. `apps/cli/indexer.ts` polls contract events
(`provider_registered` / `provider_updated`) and mirrors them into the
read-only catalog on its next poll — there is no manual approval step, the
registry is permissionless.

### 2. `.well-known/x402-discovery`

Your endpoint's origin should serve discovery metadata in the same envelope
Bazaar-compatible clients already expect (compare with the Base/Solana shape
in `discoveries/*.json`), using Stellar-specific values inside `accepts`:

```json
{
  "x402Version": 1,
  "resource": "https://yourapi.example.com/v1/endpoint",
  "description": "One-line description of what the endpoint does",
  "serviceName": "Your API Name",
  "accepts": [
    {
      "scheme": "exact",
      "network": "stellar:testnet",
      "asset": "<USDC issuer G... for the network you're on>",
      "payTo": "<G... Stellar account that receives payment>",
      "amount": "5000000",
      "maxTimeoutSeconds": 300
    }
  ],
  "category": "data",
  "lastUpdated": "2026-08-29T00:00:00Z"
}
```

- `network` uses a `stellar:testnet` / `stellar:public` namespace — Stellar's
  analog to the `eip155:8453` / `solana:...` values already used for other
  chains in `discoveries/*.json`.
- `asset` is the USDC issuer account for the network you're registering on
  (see `USDC_ASSET_ISSUER` in `docs/FLOVIA-STELLAR.md` for the testnet
  issuer).
- `payTo` and `amount` must match what your `x402-stellar` middleware actually
  challenges for (see `X402ChallengeSchema` in
  `packages/x402-stellar/src/types.ts`), and `payTo` should resolve back to
  the `owner` account from your on-chain registration (or an account it
  controls) — a mismatch between the listed and actual payment destination
  reads as a trust problem, not a valid listing.
- `category` should match the on-chain `category` value exactly.

### 3. Payment account

The account configured as `destination` in your
`x402Stellar({ destination, amountUsdc, network })` middleware config
(`packages/x402-stellar`) is your payment account. It:

- must be a Stellar `G...` account able to receive native USDC on the network
  you registered for (testnet or public)
- should be controlled by, or attributable to, the same `owner` that signed
  `register_provider`
- is what payment-log indexing (`log_payment`, `apps/cli/indexer.ts`) and
  Trust Score key off of — a payment account that doesn't match your
  registry/`.well-known` listing shows up as a discrepancy, not a valid entry

## Categories

Categories are free-form Soroban `Symbol` values (lowercase, ASCII, ≤32
chars) — there is no on-chain allowlist. Values already in the catalog: `fx`,
`data`, `fintech`. Reuse one of these where it fits; otherwise pick a short,
lowercase, single-word category. It will show up as-is in
`GET /stellar/recommend?category=...` and in the catalog's category
breakdown.

## Step-by-step

1. Protect your endpoint with the `x402-stellar-1` challenge/verify flow —
   either `@flovia/x402-stellar` (`packages/x402-stellar`) or a compatible
   implementation that issues 402 challenges and verifies payment via
   Horizon.
2. Publish `.well-known/x402-discovery` at your endpoint's origin (format
   above).
3. From your `owner` account, call `register_provider` on the
   `FloviaRegistry` Soroban contract (testnet: `REGISTRY_CONTRACT_ID`; see
   `contracts/soroban-registry/README.md` for `stellar contract invoke`
   usage).
4. Wait for `apps/cli/indexer.ts` to pick up the `provider_registered` event —
   your listing then appears via `GET /stellar/providers` and in the
   frontend catalog.

## FAQ

**I run a live x402 API on Base (USDC) — can I get indexed?**

No, not today. HANDLE's registry and discovery layer are Stellar-only (see
Scope above); Base/EVM and Solana endpoints don't fit the on-chain registry —
`payment_token`, `owner`, and the `.well-known` `network` value are all
Stellar-specific — and there's no separate multi-chain registry to fall back
to. What you likely found is `GET /aeo/x402`, a read-only market-intelligence
mirror of external Base/Solana registries (CDP, Dexter, PayAI); it isn't a
submission form and doesn't accept new listings. If HANDLE adds Base support
in the future, it will be a separate, explicitly-scoped registry, not a
mixed-in extension of the Stellar one.

**Is there an approval process?**

No — the on-chain registry is permissionless; anyone who can sign a Soroban
transaction can call `register_provider`. Quality/trust is handled after the
fact via the Trust Score (age, volume, KYB, claims, recency — see
`contracts/soroban-registry/README.md` and `docs/FLOVIA-STELLAR.md`), not by
gatekeeping registration.
