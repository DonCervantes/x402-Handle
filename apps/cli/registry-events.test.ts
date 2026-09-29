import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyRegistryEvent, REGISTRY_EVENT_KINDS } from "./registry-events";

const contractId = "C_REGISTRY";

function event(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    contractId,
    topics: ["registry", kind, 7n],
    value: {},
    ...overrides,
  };
}

describe("registry event topics", () => {
  test("matches the symbols published by the contract", () => {
    const contract = readFileSync(
      new URL("../../contracts/soroban-registry/src/lib.rs", import.meta.url),
      "utf8",
    );
    const emitted = Array.from(
      contract.matchAll(/symbol_short!\("registry"\),\s*symbol_short!\("([^"]+)"\)/g),
      (match) => match[1],
    );
    expect(emitted).toEqual([...REGISTRY_EVENT_KINDS]);
  });

  test.each([
    "prov_reg",
    "prov_upd",
    "prov_off",
    "prov_on",
    "pay_log",
  ])("accepts %s from the deployed contract", (kind) => {
    expect(classifyRegistryEvent(event(kind), contractId)).toEqual({
      kind,
      providerId: 7n,
    });
  });

  test("ignores another contract, namespace, and legacy long event names", () => {
    expect(
      classifyRegistryEvent(event("prov_reg", { contractId: "C_OTHER" }), contractId),
    ).toBeNull();
    expect(
      classifyRegistryEvent(event("prov_reg", { topics: ["other", "prov_reg", 7n] }), contractId),
    ).toBeNull();
    expect(classifyRegistryEvent(event("provider_registered"), contractId)).toBeNull();
    expect(classifyRegistryEvent(event("provider_deactivated"), contractId)).toBeNull();
  });

  test("rejects malformed provider IDs", () => {
    expect(
      classifyRegistryEvent(event("prov_off", { topics: ["registry", "prov_off"] }), contractId),
    ).toBeNull();
    expect(
      classifyRegistryEvent(event("prov_on", { topics: ["registry", "prov_on", "7"] }), contractId),
    ).toBeNull();
  });
});
