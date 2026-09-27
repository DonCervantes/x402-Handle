import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createMemoryReplayStore, type ReplayStore } from "../src/replay-store";
import { type X402StellarMiddlewareOpts, x402Stellar } from "../src/server";
import type { VerifyResult } from "../src/types";

const DESTINATION = `G${"A".repeat(55)}`;
const HASH = "c".repeat(64);

const verified = (txHash: string): VerifyResult => ({
  ok: true,
  payer: `G${"B".repeat(55)}`,
  amount: "0.005",
  txHash,
  memo: "fl-test",
});

function makeApp(overrides: Partial<X402StellarMiddlewareOpts> = {}) {
  let served = 0;
  let verifications = 0;
  const app = new Hono();
  app.use(
    "/api/*",
    x402Stellar({
      destination: DESTINATION,
      amountUsdc: "0.005",
      network: "testnet",
      replayStore: createMemoryReplayStore(),
      verifyPayment: async ({ txHash }) => {
        verifications++;
        return verified(txHash);
      },
      ...overrides,
    }),
  );
  app.get("/api/rate", (c) => {
    served++;
    return c.json({ rate: 1 });
  });
  return {
    pay: (txHash: string) =>
      app.request("/api/rate", { headers: { "X-PAYMENT": `${txHash};memo=fl-test` } }),
    served: () => served,
    verifications: () => verifications,
  };
}

describe("x402Stellar replay protection", () => {
  test("serves the first redemption and rejects the second", async () => {
    const app = makeApp();
    expect((await app.pay(HASH)).status).toBe(200);

    const replay = await app.pay(HASH);
    expect(replay.status).toBe(402);
    expect(await replay.json()).toMatchObject({ error: "already_consumed" });
    expect(app.served()).toBe(1);
  });

  test("treats hash case variants as the same payment", async () => {
    const app = makeApp();
    expect((await app.pay(HASH)).status).toBe(200);
    expect((await app.pay(HASH.toUpperCase())).status).toBe(402);
    expect(app.served()).toBe(1);
  });

  test("serves concurrent redemptions of one payment exactly once", async () => {
    const app = makeApp();
    const responses = await Promise.all(Array.from({ length: 10 }, () => app.pay(HASH)));
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(app.served()).toBe(1);
  });

  test("skips on-chain verification for a hash already consumed", async () => {
    const app = makeApp();
    await app.pay(HASH);
    await app.pay(HASH);
    expect(app.verifications()).toBe(1);
  });

  test("rejects a malformed tx hash before verifying", async () => {
    const app = makeApp();
    const res = await app.pay("not-a-hash");
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "invalid_tx_hash" });
    expect(app.verifications()).toBe(0);
  });

  test("does not consume the hash when verification fails", async () => {
    const store = createMemoryReplayStore();
    const failing = makeApp({
      replayStore: store,
      verifyPayment: async () => ({ ok: false, reason: "tx_not_found" }),
    });
    expect((await failing.pay(HASH)).status).toBe(402);
    expect(await store.has(HASH)).toBe(false);
  });

  test("fails closed with 503 when the replay store is unavailable", async () => {
    const broken: ReplayStore = {
      has: async () => {
        throw new Error("db down");
      },
      claim: async () => {
        throw new Error("db down");
      },
    };
    const app = makeApp({ replayStore: broken });
    const res = await app.pay(HASH);
    expect(res.status).toBe(503);
    expect(app.served()).toBe(0);
  });
});

describe("x402Stellar settlement gate", () => {
  test("awaits settlePayment before serving", async () => {
    const settled: string[] = [];
    const app = makeApp({
      settlePayment: async ({ txHash }) => {
        settled.push(txHash);
      },
    });
    expect((await app.pay(HASH)).status).toBe(200);
    expect(settled).toEqual([HASH]);
  });

  test("withholds the resource and keeps the hash consumed when settlement fails", async () => {
    const store = createMemoryReplayStore();
    const app = makeApp({
      replayStore: store,
      settlePayment: async () => {
        throw new Error("PaymentAlreadyLogged");
      },
    });
    const res = await app.pay(HASH);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "settlement_failed" });
    expect(app.served()).toBe(0);
    expect(await store.has(HASH)).toBe(true);
  });
});
