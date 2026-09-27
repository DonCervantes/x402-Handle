import { describe, expect, test } from "bun:test";
import { Asset, Networks } from "@stellar/stellar-sdk";
import {
  assertUsdcPaymentToken,
  resolveStellarEnv,
  STELLAR_NETWORK_PROFILES,
} from "../src/networks";

const TESTNET_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PUBLIC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("STELLAR_NETWORK_PROFILES", () => {
  test("uses the canonical network passphrases", () => {
    expect(STELLAR_NETWORK_PROFILES.testnet.networkPassphrase).toBe(Networks.TESTNET);
    expect(STELLAR_NETWORK_PROFILES.public.networkPassphrase).toBe(Networks.PUBLIC);
  });

  test.each([
    "testnet",
    "public",
  ] as const)("%s USDC SAC is derived from its issuer and passphrase", (network) => {
    const profile = STELLAR_NETWORK_PROFILES[network];
    const derived = new Asset("USDC", profile.usdc.issuer).contractId(profile.networkPassphrase);
    expect(profile.usdc.sacContractId).toBe(derived);
  });

  test("pins Circle's USDC SACs", () => {
    expect(STELLAR_NETWORK_PROFILES.testnet.usdc.sacContractId).toBe(TESTNET_SAC);
    expect(STELLAR_NETWORK_PROFILES.public.usdc.sacContractId).toBe(PUBLIC_SAC);
  });
});

describe("assertUsdcPaymentToken", () => {
  test("accepts the network's own USDC SAC", () => {
    expect(() => assertUsdcPaymentToken("testnet", TESTNET_SAC)).not.toThrow();
    expect(() => assertUsdcPaymentToken("public", PUBLIC_SAC)).not.toThrow();
  });

  test("rejects the other network's USDC SAC", () => {
    expect(() => assertUsdcPaymentToken("testnet", PUBLIC_SAC)).toThrow(/Public USDC/);
    expect(() => assertUsdcPaymentToken("public", TESTNET_SAC)).toThrow(/Testnet USDC/);
  });

  test("rejects placeholders such as an account address or arbitrary contract", () => {
    expect(() => assertUsdcPaymentToken("testnet", `G${"A".repeat(55)}`)).toThrow(/payment_token/);
    expect(() => assertUsdcPaymentToken("testnet", CONTRACT)).toThrow(/payment_token/);
  });
});

describe("resolveStellarEnv", () => {
  test("defaults testnet to the SDF RPC", () => {
    const env = resolveStellarEnv({ STELLAR_NETWORK: "testnet" });
    expect(env.network).toBe("testnet");
    expect(env.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(env.profile.usdc.sacContractId).toBe(TESTNET_SAC);
  });

  test("requires STELLAR_NETWORK to be explicit", () => {
    expect(() => resolveStellarEnv({})).toThrow(/STELLAR_NETWORK/);
    expect(() => resolveStellarEnv({ STELLAR_NETWORK: "mainnet" })).toThrow(/STELLAR_NETWORK/);
  });

  test("requires STELLAR_RPC_URL on public", () => {
    expect(() => resolveStellarEnv({ STELLAR_NETWORK: "public" })).toThrow(/STELLAR_RPC_URL/);
    expect(
      resolveStellarEnv({ STELLAR_NETWORK: "public", STELLAR_RPC_URL: "https://rpc.example" })
        .rpcUrl,
    ).toBe("https://rpc.example");
  });

  test("honours the deprecated SOROBAN_RPC_URL fallback", () => {
    expect(
      resolveStellarEnv({ STELLAR_NETWORK: "testnet", SOROBAN_RPC_URL: "https://old.example" })
        .rpcUrl,
    ).toBe("https://old.example");
  });

  test("rejects a passphrase from the other network", () => {
    expect(() =>
      resolveStellarEnv({
        STELLAR_NETWORK: "testnet",
        STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
      }),
    ).toThrow(/STELLAR_NETWORK_PASSPHRASE/);
  });

  test("rejects a USDC SAC override from the other network", () => {
    expect(() =>
      resolveStellarEnv({ STELLAR_NETWORK: "testnet", USDC_SAC_CONTRACT_ID: PUBLIC_SAC }),
    ).toThrow(/Public USDC/);
  });

  test("validates REGISTRY_CONTRACT_ID when present", () => {
    expect(
      resolveStellarEnv({ STELLAR_NETWORK: "testnet", REGISTRY_CONTRACT_ID: CONTRACT })
        .registryContractId,
    ).toBe(CONTRACT);
    expect(() =>
      resolveStellarEnv({ STELLAR_NETWORK: "testnet", REGISTRY_CONTRACT_ID: "nope" }),
    ).toThrow(/REGISTRY_CONTRACT_ID/);
  });
});
