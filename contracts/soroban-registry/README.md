# flovia-registry — Contrato Soroban

> Registry on-chain de proveedores + log de pagos. Es el "anchor" de identidad y reputación de Flovia.

## Stellar Public release gate

A Public deployment is blocked until the [Stellar mainnet go-live checklist](../../docs/stellar-mainnet-go-live-checklist.md) has a signed `GO` decision. In particular, do not deploy while `log_payment` authorization, pause/admin recovery, TTL persistence, Testnet evidence, or WASM verification is unresolved. Issue [#41](https://github.com/DonCervantes/x402-Handle/issues/41) tracks the approval and any explicit waivers.

## Qué hace

- **`register_provider(...)`** — un proveedor registra su servicio en el catálogo público.
- **`update_provider(id, ...)`** — el owner actualiza campos mutables (precio, endpoint, metadata).
- **`deactivate(id)`** — el owner pausa el listing.
- **`log_payment(caller, provider_id, payer, amount, tx_hash)`** — registra que se cobró por uso; sólo callers allowlisted (con su firma) pueden llamar; protección contra duplicados por `tx_hash`.
- **Lecturas:** `get_provider(id)`, `list_providers()`, `get_payment_log(provider_id, limit)`.

## Controles de admin

Sólo el admin (fijado en `initialize`) puede llamar estas funciones:

- **`pause()` / `unpause()` / `paused()`** — congela el registry: mientras está pausado, `register_provider`, `update_provider`, `deactivate`, `activate` y `log_payment` fallan con `Error::Paused`. Las lecturas siguen disponibles.
- **`transfer_admin(new_admin)`** — transfiere el rol de admin a otra dirección (útil para rotar keys comprometidas).
- **`add_logger(address)` / `remove_logger(address)` / `is_logger(address)` / `logger_count()`** — mantienen la allowlist de callers autorizados de `log_payment`. `log_payment` exige que `caller` esté en la allowlist y firme la invocación.

## Eventos

- `provider_registered(id, owner)` — emitido al crear.
- `provider_updated(id)` — emitido al actualizar.
- `provider_deactivated(id)` — emitido al pausar.
- `payment_logged(provider_id, payer, amount, tx_hash)` — emitido al loguear pago.
- `paused` / `unpause` — emitidos al pausar/reanudar el registry.
- `admin_chg` — emitido al transferir admin (data = nueva dirección admin).
- `log_add` / `log_del` — emitidos al modificar la allowlist de loggers (topic = dirección).

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

## Admin ops (testnet)

```bash
# Pausar / reanudar
stellar contract invoke --id $REGISTRY_CONTRACT_ID --source <admin-secret> --network testnet -- pause
stellar contract invoke --id $REGISTRY_CONTRACT_ID --source <admin-secret> --network testnet -- unpause

# Transferir admin
stellar contract invoke --id $REGISTRY_CONTRACT_ID --source <admin-secret> --network testnet \
  -- transfer_admin --new_admin <new-admin-public-key>

# Allowlist de log_payment
stellar contract invoke --id $REGISTRY_CONTRACT_ID --source <admin-secret> --network testnet \
  -- add_logger --address <logger-public-key>
stellar contract invoke --id $REGISTRY_CONTRACT_ID --source <admin-secret> --network testnet \
  -- remove_logger --address <logger-public-key>
```
```

## Notas de seguridad / scope

- `log_payment` está restringido a callers allowlisted (admin agrega oracles / middleware con `add_logger`). El caller debe firmar la invocación y estar en la allowlist; además la unicidad de `tx_hash` protege contra replays.
- El admin puede congelar el registry ante un compromiso (`pause`) y rotar la key de admin (`transfer_admin`).
- El contrato no custodia fondos: sólo registra metadata.
- `metadata_hash` es un `BytesN<32>` para apuntar a metadata extendida off-chain (IPFS, gateway HTTP), manteniéndolo barato en storage.
