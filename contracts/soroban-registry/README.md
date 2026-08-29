# HANDLE registry — Contrato Soroban

> Registry on-chain de proveedores + log de pagos. Es el "anchor" de identidad y reputación de HANDLE.
> (El paquete Rust todavía se llama `flovia-registry`; el rename completo es #29.)

## Qué hace

- **`register_provider(...)`** — un proveedor registra su servicio en el catálogo público.
- **`update_provider(id, ...)`** — el owner actualiza campos mutables (precio, endpoint, metadata).
- **`deactivate(id)`** / **`activate(id)`** — el owner pausa/reactiva el listing.
- **`log_payment(provider_id, payer, amount, tx_hash)`** — registra que se cobró por uso (cualquiera puede llamarlo; protección contra duplicados por `tx_hash`).
- **Lecturas:** `get_provider(id)`, `provider_count()`, `list_providers(from_id, to_id)`, `get_payment(id)`, `payment_count()`, `list_payments(provider_id, from_id, to_id)`.

## Eventos

Cada evento se publica con topics `("registry", <tipo>, provider_id)` usando `symbol_short!`, así que los nombres on-chain son los cortos de la tabla (no existen nombres largos tipo `provider_registered`):

| topic\[1] | Emitido por | data |
| --- | --- | --- |
| `prov_reg` | `register_provider` | `Provider` |
| `prov_upd` | `update_provider` | `Provider` |
| `prov_off` | `deactivate` | `()` |
| `prov_on` | `activate` | `()` |
| `pay_log` | `log_payment` | `PaymentLog` |

El indexer (`apps/cli/indexer.ts`) filtra por `topics[1]`; el filtro vive en `apps/cli/registry-events.ts` y está testeado contra el fixture `apps/cli/fixtures/registry-events.json`.

## Build

```bash
cd contracts/soroban-registry
stellar contract build
# o:
cargo build --target wasm32-unknown-unknown --release
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

El nombre `flovia_registry.wasm` sale del `name = "flovia-registry"` del `Cargo.toml` (guiones pasan a guiones bajos); si #29 renombra el paquete, cambia también el `.wasm`.

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
