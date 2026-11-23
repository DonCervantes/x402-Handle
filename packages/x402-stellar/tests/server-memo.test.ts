import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createChallengeStore } from "../src/challenge-store";
import { createReplayCache } from "../src/replay-cache";
import { x402Stellar } from "../src/server";
import type { VerifyOpts } from "../src/verify";
import type { VerifyResult } from "../src/types";

const DESTINATION = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const AMOUNT = "0.005";

function setup() {
  const challengeStore = createChallengeStore();
  // No Horizon access: this mock stands in for the network call. Tests assert
  // both that it is (not) called and what challenge terms it receives.
  const verifyPayment = mock(
    async (opts: VerifyOpts): Promise<VerifyResult> => ({
      ok: true,
      payer: "GPAYER",
      amount: opts.expected.amountUsdc,
      txHash: opts.txHash,
      memo: opts.expected.memo,
    }),
  );
  const app = new Hono();
  app.use(
    "*",
    x402Stellar({
      network: "testnet",
      destination: DESTINATION,
      amountUsdc: AMOUNT,
      challengeStore,
      replayCache: createReplayCache(),
      verifyPayment,
    }),
  );
  app.get("*", (c) => c.text("ok"));
  app.post("*", (c) => c.text("ok"));
  return { app, challengeStore, verifyPayment };
}

async function issueChallenge(app: Hono) {
  const response = await app.request("/paid");
  expect(response.status).toBe(402);
  return (await response.json()) as {
    memo: string;
    expires_at: string;
    amount: string;
    destination: string;
  };
}

const payWith = (memo: string, txHash = "tx-1") =>
  new Request(`http://localhost/paid`, {
    method: "POST",
    headers: { "X-PAYMENT": `${txHash};memo=${memo}` },
  });

describe("x402Stellar memo registry", () => {
  test("persists memo, expiry, amount and destination when issuing a challenge", async () => {
    const { app, challengeStore } = setup();
    const challenge = await issueChallenge(app);

    expect(challengeStore.get(challenge.memo)).toEqual({
      expires_at: challenge.expires_at,
      amount: AMOUNT,
      destination: DESTINATION,
    });
    expect(challengeStore.size()).toBe(1);
  });

  test("accepts a valid memo and verifies against the persisted challenge", async () => {
    const { app, challengeStore, verifyPayment } = setup();
    const challenge = await issueChallenge(app);

    const response = await app.request(payWith(challenge.memo, "tx-valid"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(verifyPayment).toHaveBeenCalledTimes(1);
    expect(verifyPayment.mock.calls[0]?.[0].expected).toMatchObject({
      memo: challenge.memo,
      amountUsdc: AMOUNT,
      destination: DESTINATION,
      network: "testnet",
    });
    // A consumed memo cannot be replayed with another transaction hash.
    expect(challengeStore.get(challenge.memo)).toBeUndefined();
  });

  test("rejects an expired memo before calling Horizon", async () => {
    const { app, challengeStore, verifyPayment } = setup();
    const challenge = await issueChallenge(app);
    challengeStore.issue(challenge.memo, {
      expires_at: "2000-01-01T00:00:00.000Z",
      amount: AMOUNT,
      destination: DESTINATION,
    });

    const response = await app.request(payWith(challenge.memo));
    const body = (await response.json()) as { error: string; detail: string };

    expect(response.status).toBe(402);
    expect(body.error).toBe("challenge_expired");
    expect(body.detail).toContain("expired");
    expect(verifyPayment).not.toHaveBeenCalled();
  });

  test("rejects an unknown memo before calling Horizon", async () => {
    const { app, verifyPayment } = setup();

    const response = await app.request(payWith("fl-never-issued"));
    const body = (await response.json()) as { error: string; detail: string };

    expect(response.status).toBe(402);
    expect(body.error).toBe("unknown_memo");
    expect(body.detail).toContain("not issued");
    expect(verifyPayment).not.toHaveBeenCalled();
  });

  test("a cleared store makes previously issued memos unknown", async () => {
    const { app, challengeStore, verifyPayment } = setup();
    const challenge = await issueChallenge(app);
    challengeStore.clear();

    const response = await app.request(payWith(challenge.memo));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(402);
    expect(body.error).toBe("unknown_memo");
    expect(verifyPayment).not.toHaveBeenCalled();
  });
});
