import { describe, expect, test } from "bun:test";
import { DailySpendBudget, x402Pay } from "../src/client";
import type { X402Challenge } from "../src/types";

const DAY_MS = 86_400_000;

function makeChallengeResponse(amount: string): Response {
  const challenge: X402Challenge = {
    version: "x402-stellar-1",
    network: "testnet",
    asset: {
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    },
    amount,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    memo: "fl-budget-test",
    expires_at: "2030-01-01T00:00:00.000Z",
  };
  return new Response(JSON.stringify(challenge), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

describe("DailySpendBudget", () => {
  test("allows multiple reservations under the daily cap", () => {
    let nowMs = 1_700_000_000_000;
    const budget = new DailySpendBudget({ capUsdc: 0.3, now: () => nowMs });

    budget.reserve(0.1);
    budget.reserve(0.2);

    expect(budget.spentUsdc).toBe(0.3);
    expect(budget.remainingUsdc).toBe(0);
  });

  test("rejects reservations that would exceed the daily cap without mutating spent", () => {
    let nowMs = 1_700_000_000_000;
    const budget = new DailySpendBudget({ capUsdc: 0.5, now: () => nowMs });

    budget.reserve(0.3);
    expect(() => budget.reserve(0.25)).toThrow(/exceeds dailyCapUsdc/);
    expect(budget.spentUsdc).toBe(0.3);
    expect(budget.remainingUsdc).toBe(0.2);
  });

  test("resets spent amount when the injectable clock crosses UTC midnight", () => {
    let nowMs = Date.UTC(2026, 0, 1, 23, 59, 0);
    const budget = new DailySpendBudget({ capUsdc: 0.5, now: () => nowMs });

    budget.reserve(0.5);
    expect(budget.remainingUsdc).toBe(0);
    expect(() => budget.reserve(0.01)).toThrow(/exceeds dailyCapUsdc/);

    nowMs += DAY_MS;
    expect(budget.spentUsdc).toBe(0);
    expect(budget.remainingUsdc).toBe(0.5);

    budget.reserve(0.4);
    expect(budget.spentUsdc).toBe(0.4);
  });

  test("releases reserved budget when a payment fails before completion", () => {
    const budget = new DailySpendBudget({ capUsdc: 1, now: () => 0 });
    const release = budget.reserve(0.6);
    expect(budget.spentUsdc).toBe(0.6);

    release();
    expect(budget.spentUsdc).toBe(0);
    expect(budget.remainingUsdc).toBe(1);
  });
});

describe("x402Pay daily budget enforcement", () => {
  test("fails before signing when challenge exceeds dailyBudget", async () => {
    const budget = new DailySpendBudget({ capUsdc: 0.5, now: () => 0 });
    budget.reserve(0.4);

    await expect(
      x402Pay({
        url: "https://provider.test/fx",
        // Invalid seed: if signing were reached, Keypair.fromSecret would throw first.
        agentSecret: "NOT_A_VALID_STELLAR_SECRET",
        network: "testnet",
        fetchImpl: async () => makeChallengeResponse("0.2"),
        dailyBudget: budget,
      }),
    ).rejects.toThrow(/exceeds dailyCapUsdc/);

    expect(budget.spentUsdc).toBe(0.4);
  });
});
