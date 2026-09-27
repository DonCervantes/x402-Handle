// packages/x402-stellar/tests/replay-consume.test.ts
//
// Covers the TOCTOU window between the replay-cache `has()` check and the
// moment the middleware grants access:
//
//   cache.has(txHash) → Horizon verify (await) → cache.add(txHash)
//
// Two parallel requests carrying the same tx_hash can both observe
// `has() === false` and both pass. The authoritative gate is now
// `cache.consume(txHash)` — an insert-if-absent that is synchronous, so exactly
// one of the two concurrent verifications can claim the hash.

import { beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { createReplayCache } from "../src/replay-cache";

// ─── verify.ts is mocked so the tests exercise the middleware's concurrency
// control, not Horizon. ────────────────────────────────────────────────────
const PAYER = "GPAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYER";
const DESTINATION = "GDESTDESTDESTDESTDESTDESTDESTDESTDESTDESTDESTDEST";

type VerifyOutcome =
  | { ok: true; payer: string; amount: string; txHash: string; memo: string }
  | { ok: false; reason: string; detail?: string };

let verifyDelayMs = 20;
let verifyCalls = 0;
let nextVerifyOutcome: VerifyOutcome | null = null;

mock.module("../src/verify", () => ({
  verifyUsdcPayment: async (opts: {
    txHash: string;
    expected: { memo: string };
  }): Promise<VerifyOutcome> => {
    verifyCalls += 1;
    if (verifyDelayMs > 0) {
      // Simulates Horizon latency so the two requests really overlap.
      await new Promise((resolve) => setTimeout(resolve, verifyDelayMs));
    }
    return (
      nextVerifyOutcome ?? {
        ok: true,
        payer: PAYER,
        amount: "0.005",
        txHash: opts.txHash,
        memo: opts.expected.memo,
      }
    );
  },
}));

const { x402Stellar } = await import("../src/server");
const { Hono } = await import("hono");

const paidRequest = (
  app: InstanceType<typeof Hono>,
  txHash = "tximplausiblehash",
  memo = "fl-test",
) => app.request("/paid", { headers: { "X-PAYMENT": `${txHash};memo=${memo}` } });

function paidApp(replayCache = createReplayCache()) {
  const state = { nextCalls: 0 };
  const app = new Hono();
  app.use(
    "/paid",
    x402Stellar({
      destination: DESTINATION,
      amountUsdc: "0.005",
      network: "testnet",
      replayCache,
    }),
  );
  app.get("/paid", (c) => {
    state.nextCalls += 1;
    return c.text("paid");
  });
  return {
    app,
    state,
    replayCache,
    request: (txHash?: string, memo?: string) => paidRequest(app, txHash, memo),
  };
}

beforeEach(() => {
  verifyCalls = 0;
  verifyDelayMs = 20;
  nextVerifyOutcome = null;
  setSystemTime();
});

// ─── Cache primitive ──────────────────────────────────────────────────────

describe("replay cache — consume()", () => {
  test("claims a tx_hash exactly once", () => {
    const cache = createReplayCache();

    expect(cache.consume("tx1")).toBe(true);
    expect(cache.consume("tx1")).toBe(false);
    expect(cache.has("tx1")).toBe(true);
    expect(cache.size()).toBe(1);
  });

  test("only one of many concurrent claimers wins", async () => {
    const cache = createReplayCache();

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        await Promise.resolve();
        return cache.consume("tx-same");
      }),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("a claim can be retaken once the ttl has passed", () => {
    const cache = createReplayCache({ ttlMs: 1_000 });

    setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    expect(cache.consume("tx-ttl")).toBe(true);

    setSystemTime(new Date("2030-01-01T00:00:00.500Z"));
    expect(cache.consume("tx-ttl")).toBe(false);

    setSystemTime(new Date("2030-01-01T00:00:02.000Z"));
    expect(cache.has("tx-ttl")).toBe(false);
    expect(cache.consume("tx-ttl")).toBe(true);
  });

  test("add() keeps the legacy insert behaviour", () => {
    const cache = createReplayCache();

    cache.add("tx-legacy");

    expect(cache.has("tx-legacy")).toBe(true);
    expect(cache.consume("tx-legacy")).toBe(false);
  });
});

// ─── Middleware ───────────────────────────────────────────────────────────

describe("x402Stellar — concurrent verification of the same tx_hash", () => {
  test("two concurrent verifications: only one request is granted access", async () => {
    const { request, state, replayCache } = paidApp();

    const [first, second] = await Promise.all([request(), request()]);

    // Exactly one 200 and one 402 — before the fix both returned 200.
    expect([first.status, second.status].sort()).toEqual([200, 402]);

    const denied = first.status === 402 ? first : second;
    expect(await denied.json()).toEqual({
      error: "already_consumed",
      detail: "This payment was already used.",
    });

    // The protected handler ran once, and the hash is claimed once.
    expect(state.nextCalls).toBe(1);
    expect(replayCache.size()).toBe(1);
    // Both requests did verify against Horizon; only the grant is serialised.
    expect(verifyCalls).toBe(2);
  });

  test("a later replay of a granted tx_hash is rejected without re-verifying", async () => {
    const { request, state } = paidApp();

    const granted = await request();
    expect(granted.status).toBe(200);

    verifyCalls = 0;
    const replayed = await request();

    expect(replayed.status).toBe(402);
    expect((await replayed.json()).error).toBe("already_consumed");
    expect(state.nextCalls).toBe(1);
    expect(verifyCalls).toBe(0);
  });

  test("a rejected payment leaves the tx_hash unclaimed", async () => {
    const { request, state, replayCache } = paidApp();

    nextVerifyOutcome = { ok: false, reason: "memo_mismatch", detail: "wrong memo" };
    const rejected = await request();
    expect(rejected.status).toBe(402);
    expect((await rejected.json()).error).toBe("memo_mismatch");
    expect(replayCache.size()).toBe(0);

    // An attacker cannot burn an honest payer's tx_hash: once the payment
    // verifies, the same hash is still grantable.
    nextVerifyOutcome = null;
    const granted = await request();
    expect(granted.status).toBe(200);
    expect(state.nextCalls).toBe(1);
  });

  test("the loser of the race does not fire onPaymentVerified", async () => {
    const replayCache = createReplayCache();
    const verified: string[] = [];
    const state = { nextCalls: 0 };
    const app = new Hono();
    app.use(
      "/paid",
      x402Stellar({
        destination: DESTINATION,
        amountUsdc: "0.005",
        network: "testnet",
        replayCache,
        onPaymentVerified: (info) => {
          verified.push(info.txHash);
        },
      }),
    );
    app.get("/paid", (c) => {
      state.nextCalls += 1;
      return c.text("paid");
    });

    const [first, second] = await Promise.all([paidRequest(app), paidRequest(app)]);

    expect([first.status, second.status].sort()).toEqual([200, 402]);
    expect(verified).toEqual(["tximplausiblehash"]);
    expect(state.nextCalls).toBe(1);
  });
});
