import { describe, expect, test } from "bun:test";
import { createChallengeStore } from "../src/challenge-store";

describe("createChallengeStore", () => {
  test("stores and retrieves active challenges", () => {
    const store = createChallengeStore();
    const challenge = {
      memo: "fl-testmemo1",
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      amount: "0.005",
      network: "testnet" as const,
      asset: {
        code: "USDC" as const,
        issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      },
      expiresAt: Date.now() + 60000,
    };

    store.add(challenge);
    expect(store.has("fl-testmemo1")).toBe(true);
    expect(store.get("fl-testmemo1")).toEqual(challenge);
    expect(store.size()).toBe(1);
  });

  test("returns false/undefined for non-existent memos", () => {
    const store = createChallengeStore();
    expect(store.has("fl-unknown")).toBe(false);
    expect(store.get("fl-unknown")).toBeUndefined();
  });

  test("expires challenges past expiresAt", () => {
    const store = createChallengeStore();
    const expired = {
      memo: "fl-expired",
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      amount: "0.005",
      network: "testnet" as const,
      asset: {
        code: "USDC" as const,
        issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      },
      expiresAt: Date.now() - 1000, // already expired
    };

    store.add(expired);
    expect(store.has("fl-expired")).toBe(false);
    expect(store.get("fl-expired")).toBeUndefined();
  });

  test("consumes a challenge so it cannot be used again", () => {
    const store = createChallengeStore();
    const challenge = {
      memo: "fl-consume",
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      amount: "0.005",
      network: "testnet" as const,
      asset: {
        code: "USDC" as const,
        issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      },
      expiresAt: Date.now() + 60000,
    };

    store.add(challenge);
    expect(store.has("fl-consume")).toBe(true);
    store.consume("fl-consume");
    expect(store.has("fl-consume")).toBe(false);
    expect(store.get("fl-consume")).toBeUndefined();
  });
});
