/**
 * Event classification for the Soroban registry indexer.
 *
 * Pure layer: maps raw contract events to the actions the indexer must take
 * (provider upsert, payment upsert, provider deactivation/reactivation, or
 * ignore). SQL and IO stay in apps/cli/indexer.ts.
 */

export interface RegistryEvent {
  ledger: number;
  timestamp: string;
  contractId: string;
  topics: unknown[];
  value: unknown;
  type: string;
}

export type ClassifiedEvent =
  | { kind: "provider_upsert" }
  | { kind: "payment_upsert" }
  | { kind: "provider_off"; providerId: bigint }
  | { kind: "provider_on"; providerId: bigint }
  | { kind: "ignored" };

const PROVIDER_UPSERT_TOPICS = new Set(["prov_reg", "prov_upd"]);

/** Reads the numeric provider id carried in topic[2] of registry events. */
export function extractProviderIdFromTopic(topics: unknown[]): bigint | null {
  const raw = topics[2];
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  return null;
}

/** Classifies a Soroban contract event emitted by the registry. */
export function classifyEvent(ev: RegistryEvent): ClassifiedEvent {
  const kind = ev.topics?.[1];
  if (typeof kind !== "string") return { kind: "ignored" };

  if (PROVIDER_UPSERT_TOPICS.has(kind)) return { kind: "provider_upsert" };
  if (kind === "pay_log") return { kind: "payment_upsert" };

  if (kind === "prov_off" || kind === "prov_on") {
    const providerId = extractProviderIdFromTopic(ev.topics);
    if (providerId === null) return { kind: "ignored" };
    return kind === "prov_off"
      ? { kind: "provider_off", providerId }
      : { kind: "provider_on", providerId };
  }

  return { kind: "ignored" };
}

/** Composite row id used by the providers table ("contractId/providerId"). */
export function registryRowId(contractId: string, providerId: bigint): string {
  return `${contractId}/${providerId}`;
}

export interface ProviderToggleResult {
  rowId: string;
  active: boolean;
  lastSeenAt: string;
}

/** Builds the payload to mark a provider inactive on `prov_off`. */
export function deactivateProvider(
  contractId: string,
  providerId: bigint,
  eventTimestamp: string,
): ProviderToggleResult {
  return {
    rowId: registryRowId(contractId, providerId),
    active: false,
    lastSeenAt: eventTimestamp,
  };
}

/** Builds the payload to restore a provider on `prov_on`. */
export function reactivateProvider(
  contractId: string,
  providerId: bigint,
  eventTimestamp: string,
): ProviderToggleResult {
  return { rowId: registryRowId(contractId, providerId), active: true, lastSeenAt: eventTimestamp };
}
