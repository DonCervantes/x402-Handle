import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { x402Stellar } from "../src/server";
import type { ReplayStore } from "../src/replay-store";
import type { VerifyResult } from "../src/types";

const HASH = "c".repeat(64);
const payment: VerifyResult = {
  ok: true,
  txHash: HASH,
  payer: `G${"A".repeat(55)}`,
  amount: "0.005",
  memo: "challenge-memo",
};

function sharedStore(): ReplayStore {
  const consumed = new Set<string>();
  return {
    async claim(txHash) {
      if (consumed.has(txHash)) return false;
      consumed.add(txHash);
      return true;
    },
  };
}

function createApp(replayStore: ReplayStore, nextCalls: () => void) {
  const app = new Hono();
  app.use(
    "/paid",
    x402Stellar({
      destination: `G${"B".repeat(55)}`,
      amountUsdc: "0.005",
      network: "testnet",
      replayStore,
      verifyPayment: async () => payment,
    }),
  );
  app.get("/paid", (c) => {
    nextCalls();
    return c.text("paid");
  });
  return app;
}

describe("x402Stellar replay protection", () => {
  test("shares atomic claims across middleware instances", async () => {
    let nextCalls = 0;
    const store = sharedStore();
    const appA = createApp(store, () => nextCalls++);
    const appB = createApp(store, () => nextCalls++);
    const headers = { "X-PAYMENT": `${HASH};memo=challenge-memo` };

    const responses = await Promise.all([
      appA.request("/paid", { headers }),
      appB.request("/paid", { headers }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 402]);
    expect(nextCalls).toBe(1);
  });

  test("fails closed when the replay store is unavailable", async () => {
    const app = createApp(
      {
        async claim() {
          throw new Error("storage unavailable");
        },
      },
      () => {
        throw new Error("paid route must not run");
      },
    );
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await app.request("/paid", {
        headers: { "X-PAYMENT": `${HASH};memo=challenge-memo` },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "replay_store_unavailable" });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
