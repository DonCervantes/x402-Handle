/**
 * Topics de eventos del contrato registry (contracts/soroban-registry/src/lib.rs).
 *
 * Cada evento se publica con topics `("registry", <tipo>, provider_id)` usando
 * `symbol_short!`, así que lo que llega decodificado por `scValToNative` es:
 *
 *   topics[0] = "registry"           (Symbol → string)
 *   topics[1] = tipo de evento       (Symbol → string, ver REGISTRY_EVENT_KINDS)
 *   topics[2] = provider_id          (u64 → bigint)
 *
 * Tipos y payload (`data`):
 *   - "prov_reg"  → register_provider, data = Provider
 *   - "prov_upd"  → update_provider,   data = Provider
 *   - "prov_off"  → deactivate,        data = ()
 *   - "prov_on"   → activate,          data = ()
 *   - "pay_log"   → log_payment,       data = PaymentLog
 *
 * Ojo: los nombres largos tipo `provider_registered` NO existen on-chain; si el
 * indexer filtra por esos nombres nunca ve nada aunque el contrato esté vivo.
 */

export const REGISTRY_EVENT_KINDS = [
  "prov_reg",
  "prov_upd",
  "prov_off",
  "prov_on",
  "pay_log",
] as const;

export type RegistryEventKind = (typeof REGISTRY_EVENT_KINDS)[number];

export type RegistryEventAction =
  | { action: "provider_upsert"; providerId: bigint }
  | { action: "provider_active"; providerId: bigint; active: boolean }
  | { action: "payment"; providerId: bigint }
  | { action: "ignored" };

/**
 * Clasifica un evento ya decodificado (topics nativos) en la acción que el
 * indexer debe tomar. Eventos de otros contratos o con topics inesperados
 * se ignoran en vez de romper la pasada.
 */
export function classifyRegistryEvent(
  topics: readonly unknown[] | undefined,
): RegistryEventAction {
  if (!topics || topics[0] !== "registry") return { action: "ignored" };

  const kind = topics[1];
  const rawId = topics[2];
  if (typeof rawId !== "bigint" && typeof rawId !== "number") {
    return { action: "ignored" };
  }
  const providerId = BigInt(rawId);

  switch (kind) {
    case "prov_reg":
    case "prov_upd":
      return { action: "provider_upsert", providerId };
    case "prov_off":
      return { action: "provider_active", providerId, active: false };
    case "prov_on":
      return { action: "provider_active", providerId, active: true };
    case "pay_log":
      return { action: "payment", providerId };
    default:
      return { action: "ignored" };
  }
}
