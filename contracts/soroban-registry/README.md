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
- **Escrow opcional + ventana de disputa** (ver abajo): `set_escrow_config`, `open_escrow`, `dispute_escrow`, `release_escrow`, `resolve_dispute`, `get_escrow`, `escrow_count`.

## Eventos

- `provider_registered(id, owner)` — emitido al crear.
- `provider_updated(id)` — emitido al actualizar.
- `provider_deactivated(id)` — emitido al pausar.
- `payment_logged(provider_id, payer, amount, tx_hash)` — emitido al loguear pago.
- `escrow_config_set(provider_id)` — emitido al habilitar/deshabilitar escrow.
- `escrow_opened(escrow_id)` — fondos retenidos en el contrato.
- `escrow_disputed(escrow_id)` — disputa abierta dentro de la ventana.
- `escrow_released(escrow_id)` — fondos liberados al owner del provider.
- `escrow_refunded(escrow_id)` — fondos devueltos al payer por resolución del admin.

El indexer de Flovia (`apps/cli/indexer.ts`) consume estos eventos.

## Escrow + ventana de disputa (opt-in por provider)

El pago por defecto sigue siendo la transferencia directa de USDC + `log_payment`. Un provider que quiera dar garantía al payer puede habilitar el escrow:

```bash
# 1) El owner habilita el escrow y define la ventana de disputa (segundos).
stellar contract invoke --id $REGISTRY_CONTRACT_ID --source <owner-secret> --network testnet \
  -- set_escrow_config --provider_id 1 --enabled true --dispute_window_secs 86400

# 2) El payer abre la escrow: los fondos quedan retenidos en el contrato.
stellar contract invoke --id $REGISTRY_CONTRACT_ID --source <payer-secret> --network testnet \
  -- open_escrow --provider_id 1 --payer <payer> --amount 50000 --tx_hash <32-byte-hash>

# 3) Pasada la ventana sin disputa, cualquiera libera los fondos al owner.
stellar contract invoke --id $REGISTRY_CONTRACT_ID --source <any-secret> --network testnet \
  -- release_escrow --escrow_id 1
```

Reglas:

- **Opt-in**: sin `set_escrow_config`, `open_escrow` devuelve `EscrowDisabled` y el provider cobra directo.
- **Ventana**: `release_at = created_at + dispute_window_secs`. La ventana debe ser > 0 y ≤ 90 días.
- **Release**: permissionless, pero sólo a partir de `release_at` (`EscrowWindowOpen` si se intenta antes) y sólo si no hay disputa (`EscrowDisputed`).
- **Disputa**: el payer (o el admin) puede abrirla únicamente dentro de la ventana (`EscrowWindowClosed` después). Una escrow disputada no se libera sola: la resuelve el admin con `resolve_dispute(escrow_id, refund_to_payer)`.
- **Idempotencia**: el `tx_hash` que abre una escrow queda consumido con la misma protección anti-replay que `log_payment`, así que un mismo pago no puede abrir dos escrows ni loguearse dos veces.
- **Estados**: `Open → Released | Refunded | Disputed`; toda transición emite evento.

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

- En v1, `log_payment` es abierto (cualquiera puede llamar). La protección es por `tx_hash` único.
- En v2 planeamos que sólo el destino del pago (o un oracle whitelisteado) pueda llamar.
- El contrato **sólo custodia fondos mientras hay una escrow abierta**: al liberar (`release_escrow`, `dispute_escrow` + `resolve_dispute`) el saldo queda en cero. Sin escrow habilitada el contrato no toca tokens: sólo registra metadata.
- La ventana de disputa acota el tiempo en el que el payer puede reclamar y el tiempo mínimo antes de que el provider cobre; su techo (90 días) impide que un provider retenga fondos indefinidamente.
- `metadata_hash` es un `BytesN<32>` para apuntar a metadata extendida off-chain (IPFS, gateway HTTP), manteniéndolo barato en storage.
