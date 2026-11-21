# flovia-registry — Contrato Soroban

> Registry on-chain de proveedores + log de pagos. Es el "anchor" de identidad y reputación de Flovia.

## Stellar Public release gate

A Public deployment is blocked until the [Stellar mainnet go-live checklist](../../docs/stellar-mainnet-go-live-checklist.md) has a signed `GO` decision. In particular, do not deploy while `log_payment` authorization, pause/admin recovery, TTL persistence, Testnet evidence, or WASM verification is unresolved. Issue [#41](https://github.com/DonCervantes/x402-Handle/issues/41) tracks the approval and any explicit waivers.

## Qué hace

- **`register_provider(...)`** — un proveedor registra su servicio en el catálogo público.
- **`update_provider(id, ...)`** — el owner actualiza campos mutables (precio, endpoint, metadata).
- **`deactivate(id)`** — el owner pausa el listing.
- **`log_payment(provider_id, payer, amount, tx_hash)`** — registra que se cobró por uso (cualquiera puede llamarlo! protección contra duplicados por `tx_hash`).
- **Lecturas:** `get_provider(id)`, `list_providers()`, `get_payment_log(provider_id, limit)`.

## Eventos

- `provider_registered(id, owner)` — emitido al crear.
- `provider_updated(id)` — emitido al actualizar.
- `provider_deactivated(id)` — emitido al pausar.
-  payment_logged(provider_id, payer, amount, tx_hash)` — emitido al loguear pago.

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

## TTL de storage persistente e instance

El contrato extiende el TTL de las entradas persistentes clíticas del catálogo y del log de pagos para evitar que un proveedor desaparezca del catálogo o que un `tx_hash` pueda registrarse dos veces.

- Persistent: `Provider`, `Payment` entries y el marcador de duplicados `TxConsumed` se extienden a <TDL_EXTEND_LEDGeRS> ledgers (aprox. <TTL_EXTEND_SECONDS> segundos) en cada escritura.
- Instance: el TTL de la instanca se extiende en `initialize` al valor de <INSTANCE_EXTEND_LEDGERS> ledgers y se renueva en cada llamada mutante (`register_provider`, `update_provider`, `deactivate`, `log_payment`).

Los valores concretos están definidos como constantes en `contracts/soroban-registry/src/lib.rs` y se documentan en comentarios junto a cada constante.

### Runbook: qué pasa si se pierde el TTL

Si el TTL persistente vence sin que el contrato lo extienda:

- Un `Provider` puede desaparecer del catálogo: `get_provider` y `list_providers` dejan de retornarlo y el indexer pierde la reputación asociada.
- Un `TxConsumed` puede desaparecer, permitiendo que el mismo `tx_hash` se registre de nuevo y duplicando el log de pagos.
- La instancia puede quedar bloqueada si su TTL vence sin renuovación.

Recuperación: registrar de nuevo al proveedor con `register_provider` y recrear el marcador de duplicados con `log_payment` para los pagos que se puedan verificar off-chain; el log histórico anterior no se recupera desde el contrato. Para evitarlo, cualquier llamada mutante debe hacerse bajo el ventana de TTL definida y monitorearse el uso del contrato.

## Notas de seguridad / scope

- En v1, `log_payment` es abierto (cualquiera puede llamar). La protección es por `tx_hash` único.
- En v2 planeamos que sólo el destino del pago (o un oracle whitelisteado) pueda llamar.
- El contrato no custodia fondos: sólo registra metadata.
- `metadata_hash` es un `BytesN32>` para apuntar a metadata extendida off-chain (IPFS, gateway HTTP), manteniéndolo barato en storage.
