import { afterEach, describe, expect, test } from "bun:test";
import type { StellarProvider } from "contracts";
import { Flovia } from "../src/index";

const DAY_MS = 86_400_000;
const originalFetch = globalThis.fetch;

const mockProvider: StellarProvider = {
  id: "provider-1",
  name: "FX Provider",
  address: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  endpoint: "https://provider.test/fx",
  category: "fx-rates",
  priceUsdc: "0.2",
  kybVerified: true,
  trustScore: 95,
} as StellarProvider;

function make402Response(amount: string): Response {
  return new Response(
    JSON.stringify({
      version: "x402-stellar-1",
      network: "testnet",
      asset: {
        code: "USDC",
        issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      },
      amount,
      destination: mockProvider.address,
      memo: "fl-sdk-test",
      expires_at: "2030-01-01T00:00:00.000Z",
    }),
    {
      status: 402,
      headers: { "content-type": "application/json" },
    },
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Flovia dailyCapUsdc and injectable clock", () => {
  test("accepts dailyCapUsdc and now, and rejects over-cap calls before signing", async () => {
    let nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    globalThis.fetch = (async () => make402Response("0.3")) as unknown as typeof fetch;

    const flovia = new Flovia({
      secret: "NOT_A_VALID_STELLAR_SECRET",
      dailyCapUsdc: 0.25,
      now: () => nowMs,
    });

    await expect(flovia.pay(mockProvider)).rejects.toThrow(/exceeds dailyCapUsdc/);
  });

  test("allows under-cap check to pass budget gate and resets after UTC day rollover", async () => {
    let nowMs = Date.UTC(2026, 0, 1, 23, 59, 0);
    globalThis.fetch = (async () => make402Response("0.2")) as unknown as typeof fetch;

    const flovia = new Flovia({
      // Invalid seed: reaching Keypair.fromSecret proves the daily budget check passed.
      secret: "NOT_A_VALID_STELLAR_SECRET",
      dailyCapUsdc: 0.25,
      now: () => nowMs,
    });

    // Under-cap: passes budget check and reaches Keypair.fromSecret (which throws on invalid seed),
    // and because signing/submit failed, the reservation is released.
    await expect(flovia.pay(mockProvider)).rejects.toThrow(/Invalid seed/);

    // Advance clock past UTC midnight to confirm window reset works cleanly with injected clock.
    nowMs += DAY_MS;
    await expect(flovia.pay(mockProvider)).rejects.toThrow(/Invalid seed/);
  });
});
