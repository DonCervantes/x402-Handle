import { describe, expect, test } from "bun:test";
import { loadStellarConfig, StellarConfigError } from "contracts";

const contractId = "C" + "A".repeat(55);

describe("loadStellarConfig", () => {
  test("loads a coherent Testnet configuration", () => {
    expect(
      loadStellarConfig({
        REGISTRY_CONTRACT_ID: contractId,
        STELLAR_NETWORK: "testnet",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      }),
    ).toEqual({
      registryContractId: contractId,
      network: "testnet",
      sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    });
  });

  test("fails closed on a network mismatch", () => {
    expect(() =>
      loadStellarConfig({
        REGISTRY_CONTRACT_ID: contractId,
        STELLAR_NETWORK: "public",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      }),
    ).toThrow(StellarConfigError);
  });
});