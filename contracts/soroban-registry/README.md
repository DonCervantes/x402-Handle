# flovia-registry — Contrato Soroban

> Registry on-chain de proveedores + log de pagos. Es el "anchor" de identidad y reputación de Flovia.

## Stellar Public release gate

A Public deployment is blocked until the [Stellar mainnet go-live checklist](../../docs/stellar-mainnet-go-live-checklist.md) has a signed `GO` decision. In particular, do not deploy while `log_payment` authorization, pause/admin recovery, TTL persistence, Testnet evidence, or WASM verification is unresolved. Issue [#41](https://github.com/DonCervantes/x402-Handle/issues/41) tracks the approval and any explicit waivers.

## Qué hace

- **`register_provider(...)`** — un proveedor registra su servicio en el catálogo público.
- **`update_provider(id, ...)`** — el owner actualiza campos mutables (precio, endpoint, metadata).
- **`deactivate(id)`** — el owner pausa el listing.
- **`log_payment(caller, provider_id, payer, amount, tx_hash)`** — records a payment from an authenticated, allowlisted logger; duplicate `tx_hash` values are rejected.
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

## Admin controls

`pause()` and `unpause()` require the current admin's authorization. While paused,
`register_provider`, `update_provider`, `deactivate`, `activate`, and `log_payment`
fail with `Paused` (7). Reads and all admin controls remain available, allowing
the admin to rotate authority or manage loggers before resuming writes.

`transfer_admin(new_admin)` requires the current admin and immediately replaces
it. The old admin loses its authority. `admin()` and `paused()` are public reads.

`add_logger(logger)` and `remove_logger(logger)` require the current admin and
are idempotent. `is_logger(logger)` is a public membership query. The allowlist
starts empty: neither the admin nor provider owners are automatically allowed.
Each `log_payment` call requires both membership and the caller's authorization;
an unlisted caller fails with `NotAllowlisted` (8). The payer remains metadata.

After deploying this version, add each middleware or oracle account before
enabling payment logging. The TypeScript `logPaymentOnChain` helper passes the
public key derived from `callerSecret` as `caller` and signs with that same key.
Other clients must update to the new five-argument `log_payment` signature.
Existing provider/payment keys and error codes 1–6 retain their meanings; an
absent pause key means unpaused and absent logger membership means denied.

For example, on Testnet (using locally configured Stellar identities):

```bash
stellar contract invoke --id "$REGISTRY_CONTRACT_ID" --source admin --network testnet -- add_logger --logger <logger-public-key>
stellar contract invoke --id "$REGISTRY_CONTRACT_ID" --source admin --network testnet -- pause
stellar contract invoke --id "$REGISTRY_CONTRACT_ID" --source admin --network testnet -- remove_logger --logger <logger-public-key>
stellar contract invoke --id "$REGISTRY_CONTRACT_ID" --source admin --network testnet -- transfer_admin --new_admin <new-admin-public-key>
stellar contract invoke --id "$REGISTRY_CONTRACT_ID" --source new-admin --network testnet -- unpause
```

Admin events use `(registry, paused)`, `(registry, unpaused)`,
`(registry, admin_chg)`, `(registry, log_add)`, and `(registry, log_del)` topics.
Pause events have empty data; transfer and logger events contain the address.

## Notas de seguridad / scope

- `log_payment` trusts authenticated, allowlisted loggers to report verified payments. It does not independently verify settlement; `tx_hash` uniqueness prevents duplicate logs.
- El contrato no custodia fondos: sólo registra metadata.
- `metadata_hash` es un `BytesN<32>` para apuntar a metadata extendida off-chain (IPFS, gateway HTTP), manteniéndolo barato en storage.
