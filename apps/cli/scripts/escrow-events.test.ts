import { describe, expect, test } from "bun:test";
import {
  classifyEscrowEvent,
  escrowEventToRow,
  type EscrowEventKind,
  type RawContractEvent,
  type RawEscrowPayload,
} from "./escrow-events";

function escrowPayload(overrides: Partial<RawEscrowPayload> = {}): RawEscrowPayload {
  return {
    id: 1n,
    provider: "GPROVIDER",
    agent: "GAGENT",
    amount_stroops: 50_000n,
    payment_ref: new Uint8Array([7, 7, 7, 7]),
    created_at: 1_700_000_000n,
    deadline: 1_700_003_600n,
    status: "locked",
    disputed_at: undefined,
    dispute_opener: undefined,
    resolved_at: undefined,
    resolver: undefined,
    ...overrides,
  };
}

function event(
  kind: string,
  value: unknown,
  topics: unknown[] = ["escrow", kind, 1],
): RawContractEvent {
  return {
    ledger: 100,
    timestamp: "2023-11-14T22:13:20Z",
    contractId: "CESCROW",
    topics,
    value,
    type: "contract",
  };
}

describe("classifyEscrowEvent", () => {
  test("classifies escrow lifecycle events", () => {
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
    for (const kind of kinds) {
      expect(classifyEscrowEvent(event(kind, null))).toBe(kind);
    }
  });

  test("ignores non-escrow events (SAC transfers, registry events, unknown kinds)", () => {
    expect(
      classifyEscrowEvent({ ...event("lock", null, ["transfer", "GFROM", "GTO"]) }),
    ).toBeNull();
    expect(classifyEscrowEvent({ ...event("pay_log", {}, ["registry", "pay_log", 1]) })).toBeNull();
    expect(classifyEscrowEvent({ ...event("surprise", {}, ["escrow", "surprise", 1]) })).toBeNull();
  });
});

describe("escrowEventToRow", () => {
  test("maps a lock event to a full row", () => {
    const row = escrowEventToRow(event("lock", escrowPayload()), { token: "CUSDC" });
    expect(row).not.toBeNull();
    expect(row?.contractId).toBe("CESCROW");
    expect(row?.escrowId).toBe(1);
    expect(row?.providerAccount).toBe("GPROVIDER");
    expect(row?.agentAccount).toBe("GAGENT");
    expect(row?.token).toBe("CUSDC");
    expect(row?.amountStroops).toBe("50000");
    expect(row?.amountUsdc).toBe("0.0050000");
    expect(row?.paymentRef).toBe("07070707");
    expect(row?.status).toBe("locked");
    expect(row?.createdAt).toBe("2023-11-14T22:13:20.000Z");
    expect(row?.deadlineAt).toBe("2023-11-14T23:13:20.000Z");
    expect(row?.disputedAt).toBeNull();
    expect(row?.disputeOpener).toBeNull();
    expect(row?.resolvedAt).toBeNull();
    expect(row?.resolver).toBeNull();
  });

  test("maps a dispute event with dispute metadata", () => {
    const payload = escrowPayload({
      status: "disputed",
      disputed_at: 1_700_000_100n,
      dispute_opener: "GAGENT",
    });
    const row = escrowEventToRow(event("dispute", payload));
    expect(row?.status).toBe("disputed");
    expect(row?.disputedAt).toBe("2023-11-14T22:15:00.000Z");
    expect(row?.disputeOpener).toBe("GAGENT");
    // token unknown when not provided via opts
    expect(row?.token).toBeNull();
  });

  test("unwraps the nested escrow inside a resolve payload", () => {
    const payload = escrowPayload({
      status: "released",
      disputed_at: 1_700_000_100n,
      dispute_opener: "GAGENT",
      resolved_at: 1_700_000_200n,
      resolver: "GADMIN",
    });
    const value = { escrow: payload, resolver: "GADMIN", release_to_provider: true };
    const row = escrowEventToRow(event("resolve", value));
    expect(row?.status).toBe("released");
    expect(row?.resolver).toBe("GADMIN");
    expect(row?.resolvedAt).toBe("2023-11-14T22:16:40.000Z");
  });

  test("skips admin/config events and malformed payloads", () => {
    expect(escrowEventToRow(event("policy", { enabled: true }))).toBeNull();
    expect(escrowEventToRow(event("oracle", true))).toBeNull();
    expect(escrowEventToRow(event("paused", true))).toBeNull();
    expect(escrowEventToRow(event("lock", { id: "not-a-bigint" }))).toBeNull();
    expect(escrowEventToRow(event("resolve", { escrow: null }))).toBeNull();
  });

  test("treats explicit null Option fields like undefined", () => {
    const payload = escrowPayload({
      status: "refunded",
      disputed_at: null,
      dispute_opener: null,
      resolved_at: null,
      resolver: null,
    });
    const row = escrowEventToRow(event("refund", payload));
    expect(row?.status).toBe("refunded");
    expect(row?.disputedAt).toBeNull();
    expect(row?.disputeOpener).toBeNull();
  });
});
