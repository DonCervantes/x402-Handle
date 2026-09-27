import { describe, expect, test } from "bun:test";
import { x402Pay } from "../src/client";
import { x402Stellar } from "../src/server";
import type { X402Challenge } from "../src/types";

const ACCOUNT = `G${"A".repeat(55)}`;

describe("x402Stellar amount config", () => {
  test.each([
    ["abc"],
    [""],
    ["0.00000001"],
    ["-1"],
  ])("rejects amountUsdc %p at setup", (amountUsdc) => {
    expect(() => x402Stellar({ destination: ACCOUNT, amountUsdc, network: "testnet" })).toThrow(
      /invalid USDC amount/,
    );
  });
});

describe("x402Pay maxAmountUsdc guard", () => {
  const challengeFor = (amount: string): X402Challenge => ({
    version: "x402-stellar-1",
    network: "testnet",
    asset: { code: "USDC", issuer: ACCOUNT },
    amount,
    destination: ACCOUNT,
    memo: "fl-test",
    expires_at: "2030-01-01T00:00:00.000Z",
  });
  const fetch402 = (amount: string) =>
    (async () => Response.json(challengeFor(amount), { status: 402 })) as unknown as typeof fetch;

  test("refuses a challenge one stroop above the cap", async () => {
    await expect(
      x402Pay({
        url: "https://provider.example/api",
        agentSecret: "unused",
        network: "testnet",
        maxAmountUsdc: "922337203685.4775806",
        fetchImpl: fetch402("922337203685.4775807"),
      }),
    ).rejects.toThrow(/exceeds maxAmountUsdc/);
  });

  test("refuses a malformed challenge amount", async () => {
    await expect(
      x402Pay({
        url: "https://provider.example/api",
        agentSecret: "unused",
        network: "testnet",
        maxAmountUsdc: 1,
        fetchImpl: fetch402("1e-9"),
      }),
    ).rejects.toThrow(/invalid USDC amount/);
  });
});
