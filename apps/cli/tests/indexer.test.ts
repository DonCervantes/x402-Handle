import { describe, expect, test } from "bun:test";
import { providerRowId, stroopsToUsdc, tsToIso, getRegistryContractId } from "../indexer";

describe("CLI Indexer Helpers", () => {
  test("generates providerRowId with contract id and provider id", () => {
    const rowId = providerRowId(1n, "CC4M6C3UI2Y5Z2FNPTT4UCSXYWSJH2NBILEMHQYJLWJU5IHZ3GNT7EPX");
    expect(rowId).toBe("CC4M6C3UI2Y5Z2FNPTT4UCSXYWSJH2NBILEMHQYJLWJU5IHZ3GNT7EPX/1");
  });

  test("converts stroops bigint to decimal USDC string", () => {
    expect(stroopsToUsdc(10_000_000n)).toBe("1.0000000");
    expect(stroopsToUsdc(50_000n)).toBe("0.0050000");
    expect(stroopsToUsdc(0n)).toBe("0.0000000");
    expect(stroopsToUsdc(250_000_000n)).toBe("25.0000000");
  });

  test("converts unix timestamp seconds to ISO string", () => {
    const iso = tsToIso(1700000000n);
    expect(iso).toBe(new Date(1700000000 * 1000).toISOString());
  });

  test("getRegistryContractId behaves according to env", () => {
    const original = process.env.REGISTRY_CONTRACT_ID;
    try {
      delete process.env.REGISTRY_CONTRACT_ID;
      expect(() => getRegistryContractId()).toThrow("Missing REGISTRY_CONTRACT_ID");

      process.env.REGISTRY_CONTRACT_ID = "TEST_CONTRACT_ID";
      expect(getRegistryContractId()).toBe("TEST_CONTRACT_ID");
    } finally {
      if (original) {
        process.env.REGISTRY_CONTRACT_ID = original;
      } else {
        delete process.env.REGISTRY_CONTRACT_ID;
      }
    }
  });
});
