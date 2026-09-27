import { describe, expect, test } from "bun:test";
import {
  classifyEvent,
  deactivateProvider,
  extractProviderIdFromTopic,
  reactivateProvider,
  registryRowId,
  type RegistryEvent,
} from "../src/indexer-events";

const CONTRACT = "CCONTRACT123";

interface RawProviderShape {
  id: bigint;
  owner: string;
  name: string;
  endpoint: string;
  price_stroops: bigint;
  payment_token: string;
  category: string;
  created_at: bigint;
  updated_at: bigint;
  active: boolean;
}

const providerValue: RawProviderShape = {
  id: 7n,
  owner: "GOWNER",
  name: "api.example.com",
  endpoint: "https://api.example.com",
  price_stroops: 50_000n,
  payment_token: "USDC",
  category: "llm",
  created_at: 1n,
  updated_at: 2n,
  active: true,
};

function registryEvent(topic: string, value: unknown): RegistryEvent {
  return {
    ledger: 42,
    timestamp: "2026-01-01T00:00:00.000Z",
    contractId: CONTRACT,
    topics: ["registry", topic, 7],
    value,
    type: "contract",
  };
}

describe("classifyEvent", () => {
  test("classifies prov_reg and prov_upd as provider upserts", () => {
    for (const kind of ["prov_reg", "prov_upd"] as const) {
      expect(classifyEvent(registryEvent(kind, providerValue))).toEqual({
        kind: "provider_upsert",
      });
    }
  });

  test("classifies pay_log as a payment upsert", () => {
    expect(
      classifyEvent(
        registryEvent("pay_log", {
          id: 1n,
          provider_id: 7n,
          payer: "GPAYER",
          amount: 50_000n,
          tx_hash: new Uint8Array(32),
          timestamp: 3n,
        }),
      ),
    ).toEqual({ kind: "payment_upsert" });
  });

  test("classifies prov_off as a provider deactivation with its provider id", () => {
    expect(classifyEvent(registryEvent("prov_off", null))).toEqual({
      kind: "provider_off",
      providerId: 7n,
    });
  });

  test("classifies prov_on as a provider reactivation with its provider id", () => {
    expect(classifyEvent(registryEvent("prov_on", null))).toEqual({
      kind: "provider_on",
      providerId: 7n,
    });
  });

  test("ignores unrelated topics", () => {
    expect(classifyEvent(registryEvent("something_else", null))).toEqual({ kind: "ignored" });
  });

  test("ignores events with a malformed topic tuple", () => {
    expect(classifyEvent({ ...registryEvent("prov_off", null), topics: [] })).toEqual({
      kind: "ignored",
    });
  });
});

describe("extractProviderIdFromTopic", () => {
  test("reads the numeric provider id from topic[2]", () => {
    expect(extractProviderIdFromTopic(["registry", "prov_off", 7])).toBe(7n);
    expect(extractProviderIdFromTopic(["registry", "prov_off", "7"])).toBe(7n);
  });

  test("returns null when the id is missing or non-numeric", () => {
    expect(extractProviderIdFromTopic(["registry", "prov_off"])).toBeNull();
    expect(extractProviderIdFromTopic(["registry", "prov_off", "abc"])).toBeNull();
  });
});

describe("registryRowId", () => {
  test("builds the composite row id used by the providers table", () => {
    expect(registryRowId(CONTRACT, 7n)).toBe(`${CONTRACT}/7`);
  });
});

describe("toggle helpers", () => {
  test("deactivateProvider flips active to false with the event timestamp", () => {
    expect(deactivateProvider(CONTRACT, 7n, "2026-01-02T00:00:00.000Z")).toEqual({
      rowId: `${CONTRACT}/7`,
      active: false,
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    });
  });

  test("reactivateProvider flips active to true with the event timestamp", () => {
    expect(reactivateProvider(CONTRACT, 7n, "2026-01-02T00:00:00.000Z")).toEqual({
      rowId: `${CONTRACT}/7`,
      active: true,
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    });
  });
});
