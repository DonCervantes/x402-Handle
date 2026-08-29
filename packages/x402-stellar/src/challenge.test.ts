import { describe, expect, test } from "bun:test";
import { X402ChallengeSchema, isChallengeExpired } from "./types";
import { DESTINATION, TESTNET_ISSUER } from "./test-fixtures";

function makeChallenge(expiresAt: string) {
  return {
    version: "x402-stellar-1",
    network: "testnet" as const,
    asset: { code: "USDC", issuer: TESTNET_ISSUER },
    amount: "0.005",
    destination: DESTINATION,
    memo: "fl-deadbeef12",
    expires_at: expiresAt,
  };
}

describe("challenge: expiración", () => {
  test("un challenge futuro no está expirado", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const challenge = X402ChallengeSchema.parse(makeChallenge(future));
    expect(isChallengeExpired(challenge)).toBe(false);
    expect(isChallengeExpired(challenge, Date.now() + 59_000)).toBe(false);
  });

  test("un challenge pasado está expirado", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const challenge = X402ChallengeSchema.parse(makeChallenge(past));
    expect(isChallengeExpired(challenge)).toBe(true);
  });

  test("el límite exacto (<= now) cuenta como expirado", () => {
    const t = 1_700_000_000_000;
    const challenge = X402ChallengeSchema.parse(makeChallenge(new Date(t).toISOString()));
    expect(isChallengeExpired(challenge, t)).toBe(true);
    expect(isChallengeExpired(challenge, t - 1)).toBe(false);
  });
});

describe("challenge: esquema Zod", () => {
  test("rechaza memo de más de 28 bytes", () => {
    const longMemo = { ...makeChallenge(new Date(Date.now() + 1000).toISOString()), memo: "x".repeat(29) };
    expect(X402ChallengeSchema.safeParse(longMemo).success).toBe(false);
  });

  test("rechaza destination fuera de formato G...", () => {
    const bad = { ...makeChallenge(new Date(Date.now() + 1000).toISOString()), destination: "not-a-stellar-account" };
    expect(X402ChallengeSchema.safeParse(bad).success).toBe(false);
  });
});
