# flovia-registry — Contrato Soroban

> Registry on-chain de proveedores + log de pagos. Es el "anchor" de identidad y reputación de Flovia.

## Stellar Public release gate

A Public deployment is blocked until the [Stellar mainnet go-live checklist](../../docs/stellar-mainnet-go-live-checklist.md) has a signed `GO` decision. In particular, do not deploy while `log_payment` authorization, pause/admin recovery, TTL persistence, Testnet evidence, or WASM verification is unresolved. Issue [#41](https://github.com/DonCervantes/x402-Handle/issues/41) tracks the approval and any explicit waivers.

## Qué hace

- **`register_provider(...)`** — un proveedor registra su servicio en el catálogo público.
- **`update_provider(id, ...)`** — el owner actualiza campos mutables (precio, endpoint, metadata).
- **`deactivate(id)`** — el owner pausa el listing.
- **`set_oracle(oracle, allowed)`** — el admin gestiona la allowlist de oracles.
- **`log_payment(provider_id, payer, tx_hash, authorizer)`** — el owner del provider o un oracle autorizado registra un pago; el monto se toma del precio registrado y `tx_hash` sólo puede usarse una vez.
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

## Inicializar

```bash
stellar contract invoke \
  --id $REGISTRY_CONTRACT_ID \
  --source <admin-secret> \
  --network testnet \
  -- initialize --admin <admin-public-key>
```

## Notas de seguridad / scope

- `initialize` requiere la firma de la cuenta admin prevista. Esa cuenta autoriza cambios en la allowlist mediante `set_oracle`.
- `log_payment` requiere la firma del owner del provider o de una cuenta habilitada por el admin. El firmante es responsable de verificar y atestiguar el pagador y el `tx_hash`; el contrato no consulta Horizon.
- El monto no se acepta como argumento de `log_payment`: se registra el `price_stroops` configurado en el provider. Para registrar un pago variable, el flujo de autorización deberá proporcionar una verificación on-chain del monto antes de ampliar el contrato.
- El contrato no custodia fondos: sólo registra metadata.
- `metadata_hash` es un `BytesN<32>` para apuntar a metadata extendida off-chain (IPFS, gateway HTTP), manteniéndolo barato en storage.
