import { describe, expect, test } from "bun:test";
import { decideSponsorship, type SponsorshipPolicy } from "../src/sponsorship";
import type { X402Challenge } from "../src/types";

const challenge: X402Challenge = {
  version: "x402-stellar-1",
  network: "testnet",
  asset: { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  amount: "0.005",
  destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  memo: "fl-test",
  expires_at: "2030-01-01T00:00:00.000Z",
};

const policy: SponsorshipPolicy = {
  enabled: true,
  sponsorAccount: "GSPONSOR",
  dailyCapUsdc: "1",
};

const request = (overrides = {}) => ({
  challenge,
  provider: challenge.destination,
  requestedAmountUsdc: challenge.amount,
  spentTodayUsdc: "0",
  ...overrides,
});

describe("decideSponsorship", () => {
  test("allows an exact, bound Testnet challenge", () => {
    expect(decideSponsorship(policy, request())).toEqual({
      sponsored: true,
      remainingDailyCapUsdc: "0.995",
    });
  });

  test("rejects Public sponsorship by default policy", () => {
    expect(decideSponsorship(policy, request({ challenge: { ...challenge, network: "public" } }))).toEqual({
      sponsored: false,
      reason: "public_network_disabled",
    });
  });

  test("rejects a provider not bound to the challenge", () => {
    expect(decideSponsorship(policy, request({ provider: "GOTHER" }))).toEqual({
      sponsored: false,
      reason: "challenge_not_bound",
    });
  });

  test("rejects an amount different from the issued challenge", () => {
    expect(decideSponsorship(policy, request({ requestedAmountUsdc: "0.006" }))).toEqual({
      sponsored: false,
      reason: "amount_mismatch",
    });
  });

  test("rejects requests over the daily cap", () => {
    expect(decideSponsorship(policy, request({ spentTodayUsdc: "0.999" }))).toEqual({
      sponsored: false,
      reason: "daily_cap_exceeded",
    });
  });

  test("enforces provider allowlists", () => {
    expect(decideSponsorship({ ...policy, allowedProviders: ["GOTHER"] }, request())).toEqual({
      sponsored: false,
      reason: "provider_not_allowed",
    });
  });
});
