import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { VerifyOpts } from "../src/verify";
import type { VerifyResult } from "../src/types";

const verifyUsdcPayment = mock(
  async (opts: VerifyOpts): Promise<VerifyResult> => ({
    ok: true,
    payer: "GPAID",
    amount: "0.005",
    txHash: opts.txHash,
    memo: opts.expected.memo,
  })
);

mock.module("../src/verify", () => ({ verifyUsdcPayment }));
const { x402Stellar } = await import("../src/server");

const destination = "GDESTINATION";
const issuedMemo = "fl-issued";

function createApp(challengeTtlSec?: number) {
  const app = new Hono();
  app.use(
    "*",
    x402Stellar({
      destination,
      amountUsdc: "0.005",
      network: "testnet",
      ...(challengeTtlSec === undefined ? {} : { challengeTtlSec }),
    })
  );
  app.get("*", (c) => c.text("paid"));
  return app;
}

async function issueChallenge(app: Hono) {
  const response = await app.request("/resource");
  expect(response.status).toBe(402);
  return response.json() as Promise<{ memo: string }>;
}

describe("x402Stellar challenge memo validation", () => {
  test("rejects expired memos before verification", async () => {
    verifyUsdcPayment.mockClear();
    const app = createApp(-1);
    const challenge = await issueChallenge(app);

    const response = await app.request("/resource", {
      headers: { "X-PAYMENT": `tx-hash;memo=${challenge.memo}` },
    });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: "challenge_expired" });
    expect(verifyUsdcPayment).not.toHaveBeenCalled();
  });

  test("rejects unknown memos before verification", async () => {
    verifyUsdcPayment.mockClear();
    const app = createApp();

    const response = await app.request("/resource", {
      headers: { "X-PAYMENT": `tx-hash;memo=${issuedMemo}` },
    });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: "unknown_memo" });
    expect(verifyUsdcPayment).not.toHaveBeenCalled();
  });

  test("verifies a valid issued memo against its recorded terms", async () => {
    verifyUsdcPayment.mockClear();
    const app = createApp();
    const challenge = await issueChallenge(app);

    const response = await app.request("/resource", {
      headers: { "X-PAYMENT": `tx-hash;memo=${challenge.memo}` },
    });

    expect(response.status).toBe(200);
    expect(verifyUsdcPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: expect.objectContaining({
          destination,
          amountUsdc: "0.005",
          memo: challenge.memo,
        }),
      })
    );
  });
});
