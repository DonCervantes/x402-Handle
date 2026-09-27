# flovia-registry — Contrato Soroban

> Registry on-chain de proveedores + log de pagos. Es el "anchor" de identidad y reputación de Flovia.

## Stellar Public release gate

A Public deployment is blocked until the [Stellar mainnet go-live checklist](../../docs/stellar-mainnet-go-live-checklist.md) has a signed `GO` decision. In particular, do not deploy while `log_payment` authorization, pause/admin recovery, TTL persistence, Testnet evidence, or WASM verification is unresolved. Issue [#41](https://github.com/DonCervantes/x402-Handle/issues/41) tracks the approval and any explicit waivers.

## Qué hace

- **`register_provider(...)`** — un proveedor registra su servicio en el catálogo público.
- **`update_provider(id, ...)`** — el owner actualiza campos mutables (precio, endpoint, metadata).
- **`deactivate(id)`** — el owner pausa el listing.
- **`log_payment(provider_id, payer, amount, tx_hash)`** — registra que se cobró por uso (cualquiera puede llamarlo; protección contra duplicados por `tx_hash`).
- **Lecturas:** `get_provider(id)`, `list_providers()`, `get_payment_log(provider_id, limit)`.

## Eventos

- `provider_registered(id, owner)` — emitido al crear.
- `provider_updated(id)` — emitido al actualizar.
- `provider_deactivated(id)` — emitido al pausar.
- `payment_logged(provider_id, payer, amount, tx_hash)` — emitido al loguear pago.

El indexer de Flovia (`apps/cli/indexer.ts`) consume estos eventos.

## Toolchain (pinned)

| Tool | Version | Why |
| --- | --- | --- |
| `soroban-sdk` | `21.7.6` (see `Cargo.toml` / `Cargo.lock`) | Contract SDK |
| Rust | `1.81.0` + `wasm32-unknown-unknown` (see `rust-toolchain.toml`) | soroban-sdk 21 rejects the wasm reference-types that Rust >= 1.82 enables |
| `stellar-cli` | `22.8.2` | Last CLI line whose `contract build` targets `wasm32-unknown-unknown`; 23+ moves to `wasm32v1-none` for newer SDKs |

```bash
cargo install --locked stellar-cli --version 22.8.2
stellar --version   # stellar 22.8.2
```

Bump the SDK and CLI together, and re-run `cargo test` plus a Testnet deploy when you do.

## Networks

HANDLE uses two network profiles, `testnet` and `public` (mainnet). One value, `STELLAR_NETWORK`, selects the profile for both the Stellar CLI and the HANDLE scripts. The canonical definitions live in [`packages/x402-stellar/src/networks.ts`](../../packages/x402-stellar/src/networks.ts), mirrored for reference in [`networks.toml`](networks.toml).

| | `testnet` | `public` |
| --- | --- | --- |
| Passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| RPC | `https://soroban-testnet.stellar.org` (default) | **required** via `STELLAR_RPC_URL` (no SDF-hosted RPC) |
| USDC issuer (Circle) | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| USDC SAC (`payment_token`) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |

The SAC IDs are derived from the issuer and the passphrase. `packages/x402-stellar/tests/networks.test.ts` re-derives them offline, so a typo fails `bun run verify`.

### Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `STELLAR_NETWORK` | CLI + HANDLE | `testnet` or `public`. Required; there is no default. |
| `STELLAR_RPC_URL` | CLI + HANDLE | Optional on Testnet, required on Public. `SOROBAN_RPC_URL` is still read as a deprecated fallback. |
| `STELLAR_NETWORK_PASSPHRASE` | CLI + HANDLE | Required by the CLI whenever `STELLAR_RPC_URL` is set. HANDLE rejects a passphrase from the other network. |
| `STELLAR_ACCOUNT` | CLI | Name of a CLI keystore identity (e.g. `handle-admin`), **not** a secret seed. |
| `REGISTRY_CONTRACT_ID` | HANDLE | Set after deploy; validated as a `C…` contract address. |
| `USDC_SAC_CONTRACT_ID` | HANDLE | Optional. If set, it must equal the SAC for `STELLAR_NETWORK`. |

Start from [`env/testnet.env.example`](env/testnet.env.example) or [`env/public.env.example`](env/public.env.example). Copy the values into the git-ignored repo-root `.env` or export them in your shell. Keep Testnet and Public in **separate** shells or env files, never one file with both.

**Secrets:** the admin key lives only in the CLI keystore (`stellar keys generate`, stored outside the repo) or in a secret store or hardware wallet for Public. Never commit an `S…` seed, and never pass one on the command line where it lands in shell history.

## Testnet walkthrough

```bash
# 0. Load the Testnet profile (bash)
set -a; source contracts/soroban-registry/env/testnet.env.example; set +a

# 1. The CLI already knows `testnet`; confirm it
stellar network ls

# 2. Create and fund an admin identity (stored in the CLI keystore, not the repo)
stellar keys generate handle-admin --network testnet --fund
stellar keys address handle-admin

# 3. Build and test
cd contracts/soroban-registry
cargo test
stellar contract build

# 4. Deploy and initialize
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/flovia_registry.wasm \
  --source handle-admin --network testnet
# -> put the printed C… id in .env as REGISTRY_CONTRACT_ID, then:
stellar contract invoke --id "$REGISTRY_CONTRACT_ID" --source handle-admin --network testnet \
  -- initialize --admin "$(stellar keys address handle-admin)"

# 5. Read back
stellar contract invoke --id "$REGISTRY_CONTRACT_ID" --source handle-admin --network testnet \
  -- provider_count
```

Register providers with `bun --env-file=.env apps/cli/scripts/seed-providers.ts`. The script derives `payment_token` from `STELLAR_NETWORK` (the Testnet USDC SAC above) and refuses a SAC from the other network. When you invoke `register_provider` by hand, pass `--payment_token` with the SAC from the table for **the same** network.

### Public profile (after go-live approval only)

The CLI has no built-in `public` profile. Register it once with your RPC provider's URL:

```bash
stellar network add public \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "Public Global Stellar Network ; September 2015"
stellar network ls   # now lists `public`
```

Then run the same commands as the walkthrough with `--network public` and a Public-only identity. Do not run them until the [go-live checklist](../../docs/stellar-mainnet-go-live-checklist.md) has a signed `GO`.

### Guard rails

- `bun run verify` runs `scripts/check-stellar-deploy.ts`. It fails when a deploy or seed script, or non-test contract code, uses a placeholder address such as `Address::generate`, `Keypair.random()` or a "placeholder" `payment_token`. `Address::generate` is test-only (`testutils`).
- `resolveStellarEnv` / `assertUsdcPaymentToken` (exported from `@flovia/x402-stellar/networks`) reject a missing or unknown `STELLAR_NETWORK`, a Public profile without an RPC, a mismatched passphrase, and any `payment_token` that is not this network's USDC SAC.

## Notas de seguridad / scope

- En v1, `log_payment` es abierto (cualquiera puede llamar). La protección es por `tx_hash` único.
- En v2 planeamos que sólo el destino del pago (o un oracle whitelisteado) pueda llamar.
- El contrato no custodia fondos: sólo registra metadata.
- `metadata_hash` es un `BytesN<32>` para apuntar a metadata extendida off-chain (IPFS, gateway HTTP), manteniéndolo barato en storage.
