import { describe, expect, test } from "bun:test";
import { getRegistryContractId, requireRegistryContractId } from "../src/registry-config";

describe("registry contract configuration", () => {
  test("trims and returns the shared contract ID", () => {
    expect(getRegistryContractId({ REGISTRY_CONTRACT_ID: "  CABC  " })).toBe("CABC");
  });

  test("treats an empty value as missing", () => {
    expect(getRegistryContractId({ REGISTRY_CONTRACT_ID: "   " })).toBeUndefined();
    expect(() => requireRegistryContractId({ REGISTRY_CONTRACT_ID: "" })).toThrow(
      "REGISTRY_CONTRACT_ID is required",
    );
  });
});
