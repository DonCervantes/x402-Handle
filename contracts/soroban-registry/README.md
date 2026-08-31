# flovia-registry — Contrato Soroban

> Registry on-chain de proveedores + log de pagos. Es el "anchor" de identidad y reputación de Flovia.

## Stellar Public release gate

A Public deployment is blocked until the [Stellar mainnet go-live checklist](../../docs/stellar-mainnet-go-live-checklist.md) has a signed `GO` decision. In particular, do not deploy while `log_payment` authorization, pause/admin recovery, TTL persistence, Testnet evidence, or WASM verification is unresolved. Issue [#41](https://github.com/DonCervantes/x402-Handle/issues/41) tracks the approval and any explicit waivers.

## Qué hace

- **`register_provider(...)`** — un proveedor registra su servicio en el catálogo público.
- **`update_provider(id, ...)`** — el owner actualiza campos mutables (precio, endpoint, metadata).
- **`deactivate(id)`** — el owner pausa el listing.
- **`log_payment(provider_id, payer, amount, tx_hash)`** — registra que se cobró por uso; requiere autorización del owner del provider y protege contra duplicados por `tx_hash`.
- **Lecturas:** `get_provider(id)`, `list_providers()`, `get_payment_log(provider_id, limit)`.

## Eventos

- `provider_registered(id, owner)` — emitido al crear.
- `provider_updated(id)` — emitido al actualizar.
- `provider_deactivated(id)` — emitido al pausar.
- `payment_logged(provider_id, payer, amount, tx_hash)` — emitido al loguear pago.

El indexer de Flovia (`apps/cli/indexer.ts`) consume estos eventos.

## Build

```bash
cd code/soroban-registry
cargo build --target wasm32-unknown-unknown --release
# o:
stellar contract build
```

## Test

```bash
cargo test
```

## Deploy (testnet)

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/flovia_registry.wasm \
  --source <admin-secret> \
  --network testnet
```

Guardar el contract ID en `.env` como `REGISTRY_CONTRACT_ID`.

## Testnet smoke test

This path uses real signatures and does not use `mock_all_auths`. It requires
funded Testnet accounts and a running Postgres database for the indexer.

```bash
export SMOKE_OWNER_SECRET=S...
export SMOKE_PAYER_SECRET=S...
export SMOKE_PROVIDER_PUBLIC=G...
export SMOKE_USDC_SAC_CONTRACT_ID=C...
export DATABASE_URL=postgres://...
export USDC_ASSET_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5

# Run from the repository root. REGISTRY_CONTRACT_ID and SOROBAN_RPC_URL come
# from .env and must point to the same Testnet deployment.
bun run --cwd apps/cli smoke:stellar:testnet

# Also verify deactivate -> prov_off in the indexed read model.
bun run --cwd apps/cli smoke:stellar:testnet -- --deactivate
```

The script registers a provider, sends Testnet USDC through Horizon, calls
`log_payment` signed by the provider owner, proves duplicate `tx_hash`
rejection, runs the indexer once, and prints JSON containing the contract ID
and transaction hashes. Attach that JSON as the issue comment.

## Inicializar

```bash
stellar contract invoke \
  --id $REGISTRY_CONTRACT_ID \
  --source <admin-secret> \
  --network testnet \
  -- initialize --admin <admin-public-key>
```

## Notas de seguridad / scope

- `log_payment` requiere la firma del owner registrado del provider. Un oracle
  puede actuar como caller sólo si el provider delega esa autorización en una
  futura revisión del contrato.
- El contrato no custodia fondos: sólo registra metadata.
- `metadata_hash` es un `BytesN<32>` para apuntar a metadata extendida off-chain (IPFS, gateway HTTP), manteniéndolo barato en storage.
