import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { x402Stellar, type ChallengeStore } from "./server";
import { createReplayCache } from "./replay-cache";
import {
  DESTINATION,
  TESTNET_ISSUER,
  makeHorizon,
  validPayment,
  validTx,
} from "./test-fixtures";

function freshChallenge(memo: string) {
  return {
    version: "x402-stellar-1",
    network: "testnet" as const,
    asset: { code: "USDC", issuer: TESTNET_ISSUER },
    amount: "0.005",
    destination: DESTINATION,
    memo,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function makeStore(): ChallengeStore {
  const m = new Map<string, any>();
  return {
    get: (memo: string) => m.get(memo),
    set: (c: any) => {
      m.set(c.memo, c);
    },
  };
}

function buildApp(opts: {
  challengeStore: ChallengeStore;
  horizonServer: any;
  replayCache?: any;
}) {
  const app = new Hono();
  app.use(
    "/",
    x402Stellar({
      destination: DESTINATION,
      amountUsdc: "0.005",
      network: "testnet",
      challengeStore: opts.challengeStore,
      horizonServer: opts.horizonServer,
      replayCache: opts.replayCache ?? createReplayCache(),
    })
  );
  app.get("/", (c) => c.text("ok"));
  return app;
}

describe("middleware: challenge y flujo base", () => {
  test("sin X-PAYMENT devuelve 402 con challenge válido", async () => {
    const app = buildApp({ challengeStore: makeStore(), horizonServer: makeHorizon(validTx("x"), validPayment()) });
    const res = await app.request("/");
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.version).toBe("x402-stellar-1");
    expect(body.memo).toMatch(/^fl-/);
    expect(body.expires_at).toBeDefined();
    // expires_at debe estar en el futuro.
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("middleware: memo binding (end-to-end)", () => {
  test("pago válido con memo correcto sirve el recurso", async () => {
    const store = makeStore();
    store.set(freshChallenge("fl-abcdef1234"));
    const horizon = makeHorizon(validTx("fl-abcdef1234"), validPayment());
    const app = buildApp({ challengeStore: store, horizonServer: horizon });

    const res = await app.request("/", {
      headers: { "X-PAYMENT": "txhash123;memo=fl-abcdef1234" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("tx con memo distinto al challenge es rechazada (memo_mismatch)", async () => {
    const store = makeStore();
    store.set(freshChallenge("fl-boundmemo9"));
    // El doble devuelve un memo que NO coincide con el del challenge.
    const horizon = makeHorizon(validTx("fl-othermemo9"), validPayment());
    const app = buildApp({ challengeStore: store, horizonServer: horizon });

    const res = await app.request("/", {
      headers: { "X-PAYMENT": "txhash123;memo=fl-boundmemo9" },
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("memo_mismatch");
  });
});

describe("middleware: expiry", () => {
  test("rechaza un pago cuyo memo pertenece a un challenge expirado", async () => {
    const store = makeStore();
    store.set({
      version: "x402-stellar-1",
      network: "testnet",
      asset: { code: "USDC", issuer: TESTNET_ISSUER },
      amount: "0.005",
      destination: DESTINATION,
      memo: "fl-expired0001",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const app = buildApp({ challengeStore: store, horizonServer: makeHorizon(validTx("fl-expired0001"), validPayment()) });
    const res = await app.request("/", {
      headers: { "X-PAYMENT": "txhash;memo=fl-expired0001" },
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("challenge_expired");
  });
});

describe("middleware: replay", () => {
  test("el mismo tx_hash no puede comprar dos veces", async () => {
    const store = makeStore();
    store.set(freshChallenge("fl-replaymemo1"));
    const horizon = makeHorizon(validTx("fl-replaymemo1"), validPayment());
    const app = buildApp({ challengeStore: store, horizonServer: horizon });

    const first = await app.request("/", {
      headers: { "X-PAYMENT": "replay-tx;memo=fl-replaymemo1" },
    });
    expect(first.status).toBe(200);

    const second = await app.request("/", {
      headers: { "X-PAYMENT": "replay-tx;memo=fl-replaymemo1" },
    });
    expect(second.status).toBe(402);
    const body = await second.json();
    expect(body.error).toBe("already_consumed");
  });
});

describe("middleware: USDC issuer (end-to-end)", () => {
  test("rechaza pago con issuer incorrecto", async () => {
    const store = makeStore();
    store.set(freshChallenge("fl-issuermemo1"));
    const horizon = makeHorizon(
      validTx("fl-issuermemo1"),
      validPayment({ asset_issuer: "G" + "C".repeat(55) })
    );
    const app = buildApp({ challengeStore: store, horizonServer: horizon });

    const res = await app.request("/", {
      headers: { "X-PAYMENT": "tx;memo=fl-issuermemo1" },
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("asset_mismatch");
  });
});
