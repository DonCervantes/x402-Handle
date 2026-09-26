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

## Events

The contract publishes three topics: `("registry", event, provider_id)`.
The indexer in `apps/cli/indexer.ts` subscribes to these short event symbols.

| Event symbol | Emitted by | Data |
| --- | --- | --- |
| `prov_reg` | `register_provider` | `Provider` |
| `prov_upd` | `update_provider` | `Provider` |
| `prov_off` | `deactivate` | `()` |
| `prov_on` | `activate` | `()` |
| `pay_log` | `log_payment` | `PaymentLog` |

Long names such as `provider_registered` and `payment_logged` are not emitted.

## Build

```bash
cd contracts/soroban-registry
stellar contract build
```

The crate is named `flovia-registry` in `Cargo.toml`, so this build produces
`target/wasm32v1-none/release/flovia_registry.wasm` in the crate directory.
Use this same file for deployment.

## Test

```bash
cargo test
```

## Deploy (testnet)

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/flovia_registry.wasm \
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

- En v1, `log_payment` es abierto (cualquiera puede llamar). La protección es por `tx_hash` único.
- En v2 planeamos que sólo el destino del pago (o un oracle whitelisteado) pueda llamar.
- El contrato no custodia fondos: sólo registra metadata.
- `metadata_hash` es un `BytesN<32>` para apuntar a metadata extendida off-chain (IPFS, gateway HTTP), manteniéndolo barato en storage.
