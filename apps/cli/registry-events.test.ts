import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/registry-events.json";
import { classifyRegistryEvent } from "./registry-events";

// Los topics del fixture traen los u64 como number (JSON no tiene bigint).
// scValToNative los entrega como bigint, así que probamos ambas formas.
function asNativeTopics(topics: unknown[]): unknown[] {
  return topics.map((t) => (typeof t === "number" ? BigInt(t) : t));
}

describe("classifyRegistryEvent", () => {
  for (const ev of fixture.events) {
    const label = `${ev.topics[0]}/${ev.topics[1]} → ${ev.expected.action}`;

    test(`${label} (topics como bigint)`, () => {
      const result = classifyRegistryEvent(asNativeTopics(ev.topics));
      expect(result.action).toBe(ev.expected.action as never);
      if ("providerId" in ev.expected && "providerId" in result) {
        expect(result.providerId).toBe(BigInt(ev.expected.providerId));
      }
      if ("active" in ev.expected && "active" in result) {
        expect(result.active).toBe(ev.expected.active as boolean);
      }
    });

    test(`${label} (topics como number)`, () => {
      const result = classifyRegistryEvent(ev.topics);
      expect(result.action).toBe(ev.expected.action as never);
    });
  }

  test("topics undefined o vacíos se ignoran", () => {
    expect(classifyRegistryEvent(undefined).action).toBe("ignored");
    expect(classifyRegistryEvent([]).action).toBe("ignored");
    expect(classifyRegistryEvent(["registry", "pay_log"]).action).toBe("ignored");
  });
});
