import { describe, expect, test } from "bun:test";
import {
  horizon,
  networkPassphrase,
  sorobanRpc,
  USDC,
  usdcInfo,
  usdcToStroops,
  stroopsToUsdc,
} from "../src/stellar";
import { getKybStatus, setKybStatus } from "../src/kyb";

describe("Stellar Sources & Helpers", () => {
  describe("USDC conversions and constants", () => {
    test("converts usdc to stroops accurately", () => {
      expect(usdcToStroops(1)).toBe("10000000");
      expect(usdcToStroops("0.5")).toBe("5000000");
      expect(usdcToStroops("0.005")).toBe("50000");
      expect(usdcToStroops(0)).toBe("0");
    });

    test("converts stroops to usdc accurately", () => {
      expect(stroopsToUsdc(10000000)).toBe(1);
      expect(stroopsToUsdc("5000000")).toBe(0.5);
      expect(stroopsToUsdc("50000")).toBe(0.005);
      expect(stroopsToUsdc(0)).toBe(0);
    });

    test("exports correct USDC asset metadata", () => {
      expect(USDC.getCode()).toBe("USDC");
      expect(USDC.getIssuer()).toBe(usdcInfo.issuer);
      expect(usdcInfo.code).toBe("USDC");
      expect(usdcInfo.decimals).toBe(7);
      expect(typeof usdcInfo.issuer).toBe("string");
      expect(usdcInfo.issuer.length).toBeGreaterThan(0);
    });
  });

  describe("Stellar Horizon and Soroban RPC clients", () => {
    test("exports initialized horizon client and network passphrase", () => {
      expect(horizon).toBeDefined();
      expect(typeof horizon.loadAccount).toBe("function");
      expect(typeof horizon.payments).toBe("function");
      expect(typeof horizon.transactions).toBe("function");
      expect(typeof networkPassphrase).toBe("string");
      expect(networkPassphrase.length).toBeGreaterThan(0);
    });

    test("exports initialized soroban rpc client", () => {
      expect(sorobanRpc).toBeDefined();
      expect(typeof sorobanRpc.getHealth).toBe("function");
      expect(typeof sorobanRpc.getEvents).toBe("function");
      expect(typeof sorobanRpc.simulateTransaction).toBe("function");
    });
  });

  describe("KYB mock provider", () => {
    test("returns none status for unknown provider", async () => {
      const res = await getKybStatus("unknown-provider-id-999");
      expect(res).toBeDefined();
      expect(res.providerId).toBe("unknown-provider-id-999");
      expect(res.status).toBe("none");
    });

    test("returns predefined status for seeded provider", async () => {
      const res = await getKybStatus("CC4M6C3UI2Y5Z2FNPTT4UCSXYWSJH2NBILEMHQYJLWJU5IHZ3GNT7EPX/1");
      expect(res).toBeDefined();
      expect(res.status).toBe("verified");
      expect(res.kybTier).toBe(2);
    });

    test("allows setting and retrieving custom KYB record", async () => {
      const testRecord = {
        providerId: "custom-test-provider-key",
        status: "verified" as const,
        kybProvider: "test-anchor",
        kybTier: 3 as const,
        verifiedAt: "2026-09-27T00:00:00.000Z",
      };
      await setKybStatus(testRecord);
      const retrieved = await getKybStatus("custom-test-provider-key");
      expect(retrieved).toEqual(testRecord);
    });
  });
});
