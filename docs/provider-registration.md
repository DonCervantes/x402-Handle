# Third-party HANDLE provider registration

This guide covers the **Stellar/USDC HANDLE provider registry** implemented by
[`FloviaRegistry`](../contracts/soroban-registry/src/lib.rs) in the Flovia
repository. It describes the current contract and an integration review checklist;
it does not announce an approved Public deployment or a new registration API.

## Scope and availability

Providers registering in this registry must offer an API/resource paid for with
**native USDC on Stellar** using the repository's `x402-stellar-1` payment flow.
Base, other EVM chains, and Solana payment endpoints are outside this registration
scope. A Base-only service, including the service proposed in [issue #1](https://github.com/DonCervantes/x402-Handle/issues/1),
needs a Stellar payment integration before it fits this registry.

Flovia's broader market-intelligence catalogs may contain external multi-chain
services. `GET /aeo/x402` and those catalogs are discovery/read models, not HANDLE
registration endpoints. They do not turn an external service into a Stellar
registry entry. The Stellar catalog is exposed separately at `GET /stellar/providers`.

Start with **Testnet** and a contract ID/network confirmed by the registry operator.
This repository does not publish an approved Public registry ID. The
[Stellar mainnet go-live checklist](stellar-mainnet-go-live-checklist.md) is
currently **NO-GO**; a Public deployment requires its signed approval and evidence.
Neither a sample contract address nor the middleware's `public` option bypasses
that gate. Do not submit payments or registrations to an unverified contract.

## Who can register?

The current `register_provider` function is self-serve: it requires authorization
from the supplied `owner`, not an administrator's approval. A provider must control
the signing authority for that Stellar/Soroban address. A normal integration uses
a Stellar `G...` account, a signer kept private, and sufficient network fee funds.
The payment recipient must be a Stellar account able to receive the selected
network's native USDC, including its USDC trustline.

Registration does **not** certify the business, endpoint, token, or payment flow.
There is no on-chain pending-review state, KYB requirement, or moderation queue.
Successful registration immediately creates an `active: true` record. The review
below is a manual integration/readiness check, separate from contract authorization.

## Required registration fields

Supply these seven arguments to `register_provider`, in this order. `env` is the
Soroban runtime context, not an argument supplied by the provider.

| Field | Contract type / validation today | Information to supply for a Stellar integration |
| --- | --- | --- |
| `owner` | `Address`; `owner.require_auth()` | Address authorized to manage this listing. Supply the public address, never a secret seed. |
| `name` | `String`; must be nonempty | A clear service/display name. |
| `endpoint` | `String`; must be nonempty | The actual paid resource URL, preferably HTTPS. The contract does not validate URL syntax, availability, or domain ownership. |
| `price_stroops` | `u64` | Per-call price in atomic USDC units: **1 USDC = 10,000,000 units**. For `0.005` USDC, supply `50000`. The contract accepts zero; a paid endpoint's advertised price must agree with its payment challenge. |
| `payment_token` | `Address` | The selected network's USDC Stellar Asset Contract (SAC) address, normally `C...`. This is different from the classic USDC issuer account or the payment recipient. The contract currently accepts arbitrary addresses; USDC enforcement must be checked during review, and Public allowlisting is a release prerequisite. |
| `metadata_hash` | `BytesN<32>` | A 32-byte commitment to the metadata you supply for review. The contract stores opaque bytes: it does not fetch a document, choose a hashing algorithm, or check its contents. |
| `category` | `Symbol` | A short category using Soroban symbol characters (`a-z`, `A-Z`, `0-9`, `_`), up to 32 characters. Prefer consistent lowercase names. Demo seeds use `fx`, `data`, and `fintech`; there is no category allowlist. |

For example, this is a **human-readable registration worksheet**, not a JSON API
request or a directly executable transaction. Replace the placeholders and encode
the values as their Soroban types when invoking the contract:

```json
{
  "owner": "<provider's authorized Stellar address>",
  "name": "Example Weather API",
  "endpoint": "https://weather.example.com/api/forecast",
  "price_stroops": 50000,
  "payment_token": "<USDC SAC address on the selected network>",
  "metadata_hash": "<32-byte metadata hash encoded as 64 hexadecimal characters>",
  "category": "data"
}
```

`id`, `created_at`, `updated_at`, and `active` are assigned by the contract; they
are not registration inputs. The returned `provider_id` is local to that contract.
Record the network, contract ID, successful registration transaction hash, and
returned ID together. The indexer/BFF record ID is `<contractId>/<providerId>`;
an ID alone does not identify a deployment across networks.

## Payment account and off-chain metadata

Keep the payment recipient separate from the registry's `payment_token`:

- `owner` authorizes registration and later management.
- Middleware `destination` is the `G...` account receiving native USDC. It may
  differ from `owner`; explain and demonstrate the provider's control of it in
  the review material. There is no `payment_account` argument in the contract.
- `payment_token` identifies the USDC SAC for registry metadata. The middleware's
  classic payment challenge identifies USDC using `asset.code` and the network's
  **issuer** account instead; do not substitute the SAC address as that issuer.

Configure the provider using the actual
[`X402ServerConfig` and challenge schema](../packages/x402-stellar/src/types.ts):
`destination`, decimal-string `amountUsdc` (for example `"0.005"`), and `network`
(`"testnet"` initially). An unpaid request should return HTTP `402` with `version`
`"x402-stellar-1"`, `network`, `asset: { code: "USDC", issuer }`, `amount`,
`destination`, a per-request `memo`, and `expires_at`. A verified payment should
unlock the promised resource. See the [middleware guide](../packages/x402-stellar/README.md).
Publishing metadata or registering a listing does not implement this payment flow.

For review, provide a public metadata document or attach its exact bytes to the
onboarding issue. Include a service description, resource URL, category, network,
USDC issuer/SAC, price, payment destination, operator contact, and whether the
service/data is demo or real. A recommended commitment is SHA-256 of those exact
UTF-8 bytes; state that algorithm and supply the resulting 32 bytes as
`metadata_hash`. This is a review convention, not contract-enforced validation.

An origin may optionally publish that document at
`/.well-known/x402-discovery` (or link an existing `/.well-known/x402` manifest).
**No `.well-known` registration schema or automatic crawler is implemented in
this repository.** The indexer does not resolve `metadata_hash` or ingest that
document; a well-known URL is a manual discovery aid, not a submission API or
proof of registration. Do not use a generic Bazaar `accepts` envelope as though
it were the implemented Stellar challenge format.

## Onboarding and review

1. **Request integration review:** open an issue in
   [this repository](https://github.com/DonCervantes/x402-Handle/issues) with the
   seven-field worksheet, selected network, proposed registry contract ID,
   metadata/document hash, payment recipient, contact, and demo/real-data label.
   Share public identifiers and sanitized evidence only; keep signing secrets
   private. Ask the operator to confirm the deployment and indexing environment.
2. **Validate the service on Testnet:** the provider and reviewer check endpoint
   control/reachability, a consistent `402` challenge, USDC issuer/SAC/network
   agreement, recipient control/trustline, matching atomic/decimal prices, and a
   successful payment-and-resource response. Include transaction evidence and
   failure cases (unpaid request and an invalid/replayed payment), without
   suggesting that the review checklist itself enforces those checks in code.
3. **Register with the owner:** submit the owner-authorized Soroban invocation to
   the confirmed Testnet contract. Save its result and use `get_provider` to
   confirm the fields and active status. Contract acceptance is not reviewer
   endorsement; missing review evidence remains unverified.
4. **Confirm indexing and review outcome:** the configured
   [indexer](../apps/cli/indexer.ts) consumes `prov_reg`/`prov_upd` events into
   Postgres. Once it has processed the registration, check the same contract/ID
   at `GET /stellar/providers` or the provider detail route. The operator/reviewer
   should record checked evidence, discrepancies, and the demo/Testnet label in
   the onboarding issue. There is no automatic listing SLA or BFF write endpoint;
   a row in a different database, an inactive record, or a stalled/misconfigured
   indexer is not confirmation that the intended service is discoverable.
5. **Before Public:** complete the existing mainnet release gate, including
   authorized payment logging, operational recovery, TTL persistence, verified
   release WASM, correct USDC configuration, and signed go/no-go approval. The
   Testnet review is not a Public approval or an audit.

For ongoing management, the stored owner authorizes `update_provider` (price,
endpoint, and metadata hash), `deactivate`, and `activate`. The current update
function does not change owner, name, category, or token; review a new registration
with the operator if those need to change. Publish updated metadata/hash together
when mutable service details change.

Use `get_provider` to recheck activation status: the current indexer handles
`prov_reg`/`prov_upd` but does not mirror `prov_off`/`prov_on`, so the BFF's cached
database status can lag a deactivation or reactivation.

## Demo data versus a live registry entry

| What you are seeing | What it establishes |
| --- | --- |
| A worksheet, example URL, fixture, or an external market-intelligence catalog row | Documentation/demo/discovery data; no registration transaction is implied. |
| A record produced by [`seed-providers.ts`](../apps/cli/scripts/seed-providers.ts) | A demo catalog entry, even if written on Testnet. The script hardcodes Testnet, uses example endpoints, hashes its seed JSON, and uses the demo owner's public address as a **placeholder** `payment_token`, not a verified USDC SAC. Do not copy these token/endpoint values for a real integration. |
| The local [`demo-provider`](../apps/demo-provider/src/index.ts) and playground | A demonstration of the payment flow with simulated exchange rates. The playground wires only provider ID 1 to the local service; the other four seeds are catalog examples. It is not a general third-party execution path or a production-data guarantee. |
| A KYB badge or Trust Score from the current Stellar intelligence layer | Demo intelligence, not business approval: [KYB is mocked](../packages/sources/src/kyb/mock.ts), and the [BFF](../apps/bff/src/data/stellar-providers.ts) treats disputes as zero because no reporting mechanism exists. `log_payment` is currently open, so registry payment logs alone are not proof of verified settlement. |
| A confirmed `get_provider` result for the stated network/contract/ID | The on-chain record exists. It can still describe a demo, an unreviewed service, or an inactive listing; `active: true` alone proves neither availability nor endorsement. |
| A live third-party listing | A confirmed active record plus a reachable real endpoint, reviewed matching payment/metadata configuration, and verified Stellar/USDC payment-and-resource evidence on the stated network. A Testnet listing must remain labeled **Testnet/demo**, not Public production. A Public listing additionally requires the signed release approval and published deployment evidence. |

These distinctions describe readiness and evidence, not an implemented approval
flag. Until Public go-live is approved, there is no production onboarding promise
in this guide. A provider can use the Testnet review process to prepare an
integration without presenting seeded rows or mock verification as a live service.
