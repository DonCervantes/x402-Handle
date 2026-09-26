/** The second topic emitted by the deployed Soroban registry contract. */
export const REGISTRY_EVENT_KINDS = [
  "prov_reg",
  "prov_upd",
  "prov_off",
  "prov_on",
  "pay_log",
] as const;

export type RegistryEventKind = (typeof REGISTRY_EVENT_KINDS)[number];

const REGISTRY_KINDS = new Set<string>(REGISTRY_EVENT_KINDS);

export function classifyRegistryEvent(
  event: { contractId?: unknown; topics?: unknown },
  expectedContractId: string,
): { kind: RegistryEventKind; providerId: bigint } | null {
  if (event.contractId !== expectedContractId || !Array.isArray(event.topics)) {
    return null;
  }

  const [namespace, kind, rawProviderId] = event.topics;
  if (event.topics.length !== 3 || namespace !== "registry" || !REGISTRY_KINDS.has(kind)) {
    return null;
  }

  const providerId =
    typeof rawProviderId === "bigint"
      ? rawProviderId
      : typeof rawProviderId === "number" && Number.isSafeInteger(rawProviderId)
        ? BigInt(rawProviderId)
        : null;

  return providerId !== null && providerId > 0n
    ? { kind: kind as RegistryEventKind, providerId }
    : null;
}
