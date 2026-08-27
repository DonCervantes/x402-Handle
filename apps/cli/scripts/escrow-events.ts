/**
 * Escrow event → DB row mapping for apps/cli/indexer.ts.
 *
 * Pure functions on plain objects (no network, no DB) so they can be unit
 * tested deterministically. Mirrors the events emitted by
 * contracts/soroban-escrow:
 *
 *   topics = ("escrow", kind, id)   data = Escrow | Resolution | ProviderPolicy | bool
 *
 * Every Escrow payload carries the full current struct, so the resulting row
 * is a complete projection of the newest event for that escrow id — the
 * indexer can apply events out of order and re-poll ledgers safely.
 *
 * Payload field types are what @stellar/stellar-sdk's scValToNative produces
 * for the on-chain types: u64/i128 → bigint, BytesN<32> → Uint8Array,
 * Symbol → string, Address → string, Option → value | undefined.
 */

/** Event shape as returned by sources/stellar soroban-rpc.getContractEvents. */
export interface RawContractEvent {
  ledger: number;
  timestamp: string;
  contractId: string;
  topics: unknown[];
  value: unknown;
  type: string;
}

export type RawEscrowPayload = {
  id: bigint;
  provider: string;
  agent: string;
  amount_stroops: bigint;
  payment_ref: Uint8Array;
  created_at: bigint;
  deadline: bigint;
  status: string;
  disputed_at?: bigint | null;
  dispute_opener?: string | null;
  resolved_at?: bigint | null;
  resolver?: string | null;
};

export type RawResolutionPayload = {
  escrow: RawEscrowPayload;
  resolver: string;
  release_to_provider: boolean;
};

export type EscrowEventKind =
  | "lock"
  | "release"
  | "refund"
  | "dispute"
  | "resolve"
  | "policy"
  | "oracle"
  | "paused";

/** Row ready to be upserted into the `escrows` table (020 migration). */
export type EscrowRow = {
  contractId: string;
  escrowId: number;
  providerAccount: string;
  agentAccount: string;
  token: string | null;
  amountStroops: string;
  amountUsdc: string;
  paymentRef: string;
  status: string;
  createdAt: string;
  deadlineAt: string;
  disputedAt: string | null;
  disputeOpener: string | null;
  resolvedAt: string | null;
  resolver: string | null;
};

export const ESCROW_EVENT_NAMESPACE = "escrow";

/**
 * Classifies an event by its topic vector. Returns null for anything that is
 * not an escrow-namespaced event (SAC token events, registry events, …).
 */
export function classifyEscrowEvent(event: RawContractEvent): EscrowEventKind | null {
  const [ns, kind] = event.topics;
  if (ns !== ESCROW_EVENT_NAMESPACE) return null;
  const kinds: EscrowEventKind[] = [
    "lock",
    "release",
    "refund",
    "dispute",
    "resolve",
    "policy",
    "oracle",
    "paused",
  ];
  return kinds.includes(kind as EscrowEventKind) ? (kind as EscrowEventKind) : null;
}

const STROOPS_PER_USDC = 10_000_000;

function tsToIso(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

function optionalIso(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : tsToIso(value);
}

function optionalString(value: string | null | undefined): string | null {
  return value ?? null;
}

function isRawEscrow(value: unknown): value is RawEscrowPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "bigint" &&
    typeof v.provider === "string" &&
    typeof v.agent === "string" &&
    typeof v.amount_stroops === "bigint" &&
    v.payment_ref instanceof Uint8Array &&
    typeof v.created_at === "bigint" &&
    typeof v.deadline === "bigint" &&
    typeof v.status === "string"
  );
}

/**
 * Builds the projection row for one escrow-state event (lock / release /
 * refund / dispute / resolve). Returns null when the payload is malformed —
 * the indexer skips such events instead of crashing the poll loop.
 *
 * `token` is the escrow contract's pinned asset (constant per contract, not
 * part of the event payload); pass it via opts when known.
 */
export function escrowEventToRow(
  event: RawContractEvent,
  opts: { token?: string } = {},
): EscrowRow | null {
  const kind = classifyEscrowEvent(event);
  if (kind === null || kind === "policy" || kind === "oracle" || kind === "paused") return null;

  let payload = event.value;
  if (kind === "resolve") {
    // Resolution = { escrow, resolver, release_to_provider }
    if (typeof payload !== "object" || payload === null) return null;
    payload = (payload as Record<string, unknown>).escrow;
  }
  if (!isRawEscrow(payload)) return null;

  const amountStroops = payload.amount_stroops;
  return {
    contractId: event.contractId,
    escrowId: Number(payload.id),
    providerAccount: payload.provider,
    agentAccount: payload.agent,
    token: opts.token ?? null,
    amountStroops: amountStroops.toString(),
    amountUsdc: (Number(amountStroops) / STROOPS_PER_USDC).toFixed(7),
    paymentRef: Buffer.from(payload.payment_ref).toString("hex"),
    status: payload.status,
    createdAt: tsToIso(payload.created_at),
    deadlineAt: tsToIso(payload.deadline),
    disputedAt: optionalIso(payload.disputed_at),
    disputeOpener: optionalString(payload.dispute_opener),
    resolvedAt: optionalIso(payload.resolved_at),
    resolver: optionalString(payload.resolver),
  };
}
