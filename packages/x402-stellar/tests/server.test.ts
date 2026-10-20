import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { createChallengeStore } from "../src/challenge-store";
import { createReplayCache } from "../src/replay-cache";

let lastVerifyOpts: any = null;
let mockVerifyResult: any = {
  ok: true,
  payer: "GPAYER",
  amount: "0.005",
  txHash: "0123456789abcdef",
  memo: "fl-mockmemo",
};

mock.module("../src/verify", () => ({
  verifyUsdcPayment: async (opts: any) => {
    lastVerifyOpts = opts;
    return mockVerifyResult;
  },
}));

// Import after mock
const { x402Stellar } = await import("../src/server");

describe("x402Stellar server middleware", () => {
  const destination = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const amountUsdc = "0.005";

  test("returns 402 with challenge on unauthenticated request and saves memo", async () => {
    const challengeStore = createChallengeStore();
    const app = new Hono();
    app.use(
      "/api/*",
      x402Stellar({
        destination,
        amountUsdc,
        network: "testnet",
        challengeStore,
      }),
    );
    app.get("/api/data", (c) => c.text("secret content"));

    const res = await app.request("/api/data");
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.version).toBe("x402-stellar-1");
    expect(body.destination).toBe(destination);
    expect(body.amount).toBe(amountUsdc);
    expect(body.memo).toBeDefined();

    const headerMemo = res.headers.get("X-PAYMENT-MEMO");
    expect(headerMemo).toBe(body.memo);

    // Verify it is stored
    expect(challengeStore.has(body.memo)).toBe(true);
    const stored = challengeStore.get(body.memo);
    expect(stored?.destination).toBe(destination);
    expect(stored?.amount).toBe(amountUsdc);
  });

  test("rejects unknown memo not issued by server with 402", async () => {
    const challengeStore = createChallengeStore();
    const app = new Hono();
    app.use(
      "/api/*",
      x402Stellar({
        destination,
        amountUsdc,
        network: "testnet",
        challengeStore,
      }),
    );
    app.get("/api/data", (c) => c.text("secret content"));

    const res = await app.request("/api/data", {
      headers: {
        "X-PAYMENT": "some_tx_hash;memo=fl-attacker-memo",
      },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("unknown_memo");
    expect(body.detail).toBe("The provided memo was not issued by this server or has expired.");
  });

  test("rejects expired memo with 402", async () => {
    const challengeStore = createChallengeStore();
    challengeStore.add({
      memo: "fl-expired1",
      destination,
      amount: amountUsdc,
      network: "testnet",
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      expiresAt: Date.now() - 5000,
    });

    const app = new Hono();
    app.use(
      "/api/*",
      x402Stellar({
        destination,
        amountUsdc,
        network: "testnet",
        challengeStore,
      }),
    );
    app.get("/api/data", (c) => c.text("secret content"));

    const res = await app.request("/api/data", {
      headers: {
        "X-PAYMENT": "some_tx_hash;memo=fl-expired1",
      },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("unknown_memo");
  });

  test("does not accept query-string memo fallback", async () => {
    const challengeStore = createChallengeStore();
    challengeStore.add({
      memo: "fl-validmemo",
      destination,
      amount: amountUsdc,
      network: "testnet",
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      expiresAt: Date.now() + 60000,
    });

    const app = new Hono();
    app.use(
      "/api/*",
      x402Stellar({
        destination,
        amountUsdc,
        network: "testnet",
        challengeStore,
      }),
    );
    app.get("/api/data", (c) => c.text("secret content"));

    // Attempt using query-string fallback (?memo=fl-validmemo) without ;memo in header
    const res = await app.request("/api/data?memo=fl-validmemo", {
      headers: {
        "X-PAYMENT": "some_tx_hash",
      },
    });

    // Query param must NOT be used as memo; it should be rejected with missing_memo
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("missing_memo");
  });

  test("accepts valid payment with server-issued memo and binds challenge parameters", async () => {
    const challengeStore = createChallengeStore();
    const replayCache = createReplayCache();
    const challengeMemo = "fl-issued01";
    challengeStore.add({
      memo: challengeMemo,
      destination,
      amount: amountUsdc,
      network: "testnet",
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      expiresAt: Date.now() + 60000,
    });

    mockVerifyResult = {
      ok: true,
      payer: "GPAYER",
      amount: "0.005",
      txHash: "validtx123",
      memo: challengeMemo,
    };

    const app = new Hono();
    app.use(
      "/api/*",
      x402Stellar({
        destination,
        amountUsdc,
        network: "testnet",
        challengeStore,
        replayCache,
      }),
    );
    app.get("/api/data", (c) => c.text("secret content"));

    const res = await app.request("/api/data", {
      headers: {
        "X-PAYMENT": `validtx123;memo=${challengeMemo}`,
      },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("secret content");

    // Verification received bound expected parameters
    expect(lastVerifyOpts.txHash).toBe("validtx123");
    expect(lastVerifyOpts.expected.destination).toBe(destination);
    expect(lastVerifyOpts.expected.memo).toBe(challengeMemo);
    expect(lastVerifyOpts.expected.amountUsdc).toBe(amountUsdc);

    // Challenge memo should now be consumed
    expect(challengeStore.has(challengeMemo)).toBe(false);

    // Replay attack with same txHash is rejected
    const replayRes = await app.request("/api/data", {
      headers: {
        "X-PAYMENT": `validtx123;memo=${challengeMemo}`,
      },
    });
    expect(replayRes.status).toBe(402);
    const replayBody = await replayRes.json();
    expect(replayBody.error).toBe("already_consumed");
  });
});
