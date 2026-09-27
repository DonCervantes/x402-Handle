// packages/x402-stellar/tests/challenge-binding.test.ts
//
// Issue #11: the client is the only place where the destination that gets
// signed is still under the caller's control, so the binding (and the network
// pin) is enforced here — between parsing the 402 challenge and building the
// payment.
//
// Horizon is faked so the "binding holds" case can run without network access;
// the payment transaction itself is built with the real SDK.

import { describe, expect, mock, test } from "bun:test";

const MEMO = "fl-abcdef1234";

const sdk = await import("@stellar/stellar-sdk");
// Real StrKey-valid accounts: the client builds a real `Asset`/`Account`.
const OWNER = sdk.Keypair.random().publicKey();
const ATTACKER = sdk.Keypair.random().publicKey();
const ISSUER = sdk.Keypair.random().publicKey();
const agentKeypair = sdk.Keypair.random();

const submitted: any[] = [];

class FakeHorizonServer {
  constructor(_url: string) {}
  async loadAccount(accountId: string) {
    return new sdk.Account(accountId, "1");
  }
  async submitTransaction(tx: any) {
    submitted.push(tx);
    return { hash: "d".repeat(64) };
  }
}

mock.module("@stellar/stellar-sdk", () => ({
  ...sdk,
  Horizon: { ...sdk.Horizon, Server: FakeHorizonServer },
}));

const { x402Pay } = await import("../src/client");

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    version: "x402-stellar-1",
    network: "testnet",
    asset: { code: "USDC", issuer: ISSUER },
    amount: "0.005",
    destination: OWNER,
    memo: MEMO,
    expires_at: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** fetch stub: 402 with `challengeBody` first, 200 JSON afterwards. */
function paidEndpoint(challengeBody: unknown) {
  let call = 0;
  return async (): Promise<Response> => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify(challengeBody), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ pair: "EUR/USD", rate: 1.0843 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const pay = (opts: Record<string, unknown> = {}) =>
  x402Pay({
    url: "https://provider.example.com/api/rate",
    agentSecret: agentKeypair.secret(),
    network: "testnet",
    fetchImpl: paidEndpoint(challenge()) as unknown as typeof fetch,
    ...opts,
  });

describe("x402Pay — challenge binding", () => {
  test("pays to the expected destination and reports it", async () => {
    const result = await pay({ expectedDestination: OWNER });

    expect(result.response.status).toBe(200);
    expect(result.data).toEqual({ pair: "EUR/USD", rate: 1.0843 });
    expect(result.payment.destination).toBe(OWNER);
    expect(result.payment.txHash).toBe("d".repeat(64));

    // The signed operation really pays the bound account.
    expect(submitted).toHaveLength(1);
    expect(submitted[0].operations[0].destination).toBe(OWNER);
    // The SDK normalises the amount to 7 decimals.
    expect(Number(submitted[0].operations[0].amount)).toBe(0.005);
  });

  test("aborts before signing when the endpoint points somewhere else", async () => {
    const before = submitted.length;

    await expect(
      pay({
        expectedDestination: OWNER,
        fetchImpl: paidEndpoint(challenge({ destination: ATTACKER })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/destination mismatch/);

    // Nothing was signed or submitted — the diverted payment never exists.
    expect(submitted).toHaveLength(before);
  });

  test("aborts on a challenge issued for another network", async () => {
    await expect(
      pay({
        fetchImpl: paidEndpoint(challenge({ network: "public" })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/network mismatch/);
  });

  test("keeps the pre-existing behaviour when no destination is expected", async () => {
    const result = await pay();
    expect(result.payment.destination).toBe(OWNER);
  });
});
