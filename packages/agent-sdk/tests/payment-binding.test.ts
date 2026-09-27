// packages/agent-sdk/tests/payment-binding.test.ts
//
// Issue #11: the agent must only ever pay the account the Soroban registry
// declares for the provider, never the `destination` an HTTPS endpoint claims.
//
// `x402Pay` is mocked here — these tests assert what the SDK *binds* before it
// delegates (expectedDestination, network pin, endpoint policy). The
// enforcement of that binding is covered in
// packages/x402-stellar/tests/challenge-binding.test.ts.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StellarProvider } from "contracts";
import type { X402PayOpts, X402PayResult } from "@flovia/x402-stellar/client";

const OWNER = `G${"A".repeat(55)}`;
const ATTACKER = `G${"B".repeat(55)}`;
const TX_HASH = "a".repeat(64);

let calls: X402PayOpts[] = [];

mock.module("@flovia/x402-stellar/client", () => ({
  x402Pay: async (opts: X402PayOpts): Promise<X402PayResult> => {
    calls.push(opts);
    return {
      response: new Response(JSON.stringify({ pair: "EUR/USD", rate: 1.0843 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      data: { pair: "EUR/USD", rate: 1.0843 },
      payment: {
        txHash: TX_HASH,
        amount: "0.005",
        memo: "fl-abcdef1234",
        destination: opts.expectedDestination ?? "",
      },
      elapsedMs: 7,
    };
  },
}));

const { Flovia } = await import("../src/index");
const { matchesHost } = await import("../src/policy");

function provider(overrides: Partial<StellarProvider> = {}): StellarProvider {
  return {
    id: "CREGISTRY/1",
    contractId: "CREGISTRY",
    providerId: 1,
    name: "FX Rates",
    endpoint: "https://provider.example.com/api/rate",
    priceUsdc: 0.005,
    ownerAccount: OWNER,
    paymentAsset: "USDC",
    category: "fx-rates",
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: null,
    ...overrides,
  };
}

const agent = (opts: Partial<ConstructorParameters<typeof Flovia>[0]> = {}) =>
  new Flovia({ secret: "SATTACKERATTACKERATTACKERATTACKERATTACKERATTACKERATTACKER", ...opts });

beforeEach(() => {
  calls = [];
});

describe("Flovia.pay — destination is bound to the registry", () => {
  test("forwards the registry owner as expectedDestination", async () => {
    const result = await agent().pay(provider(), { pair: "EUR/USD" });

    expect(calls).toHaveLength(1);
    expect(calls[0].expectedDestination).toBe(OWNER);
    expect(calls[0].network).toBe("testnet");
    expect(calls[0].url).toBe("https://provider.example.com/api/rate?pair=EUR%2FUSD");
    expect(result).toEqual({
      txHash: TX_HASH,
      amountUsdc: "0.005",
      memo: "fl-abcdef1234",
      data: { pair: "EUR/USD", rate: 1.0843 },
      elapsedMs: 7,
    });
  });

  test("refuses to pay when the registry declares no owner account", async () => {
    await expect(agent().pay(provider({ ownerAccount: "" }))).rejects.toThrow(/ownerAccount/);
    // Never asked the endpoint for a challenge, let alone signed one.
    expect(calls).toHaveLength(0);
  });

  test("pins the challenge to the configured network", async () => {
    await agent({ network: "public" }).pay(provider());

    expect(calls[0].network).toBe("public");
    expect(calls[0].expectedDestination).toBe(OWNER);
  });

  test("discovers, prices and pays through the same binding", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([{ provider: provider(), trustScore: 91, matchScore: 0.9, reasons: [] }]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch;

    try {
      const result = await agent().discoverAndCall({ need: "fx-rates", maxPrice: 0.01 });

      expect(calls).toHaveLength(1);
      expect(calls[0].expectedDestination).toBe(OWNER);
      expect(result.provider.ownerAccount).toBe(OWNER);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Flovia.pay — endpoint policy", () => {
  test("refuses a non-HTTPS provider endpoint before any payment", async () => {
    await expect(
      agent().pay(provider({ endpoint: "http://provider.example.com/api/rate" })),
    ).rejects.toThrow(/non-HTTPS/);
    expect(calls).toHaveLength(0);
  });

  test("allows http only with the explicit local-development opt-in", async () => {
    const insecure = agent({ allowInsecureEndpoint: true });
    await insecure.pay(provider({ endpoint: "http://localhost:8080/rate" }));

    expect(calls[0].url).toBe("http://localhost:8080/rate");
    expect(calls[0].expectedDestination).toBe(OWNER);
  });

  test("refuses a provider host outside the allowlist", async () => {
    await expect(agent({ allowedHosts: ["api.allowed.com"] }).pay(provider())).rejects.toThrow(
      /not in the allowed hosts/,
    );
    expect(calls).toHaveLength(0);
  });

  test("accepts an allowlisted host, including subdomain wildcards", async () => {
    await agent({ allowedHosts: ["*.allowed.com"] }).pay(
      provider({ endpoint: "https://api.allowed.com/rate" }),
    );
    expect(calls).toHaveLength(1);

    await expect(
      agent({ allowedHosts: ["api.allowed.com"] }).pay(
        provider({ endpoint: "https://evil.allowed.com.attacker.net/rate" }),
      ),
    ).rejects.toThrow(/not in the allowed hosts/);
  });

  test("rejects a malformed endpoint URL", async () => {
    await expect(agent().pay(provider({ endpoint: "not-a-url" }))).rejects.toThrow(
      /not a valid URL/,
    );
  });
});

describe("matchesHost", () => {
  test("matches exact hosts case-insensitively", () => {
    expect(matchesHost("API.Allowed.com", "api.allowed.com")).toBe(true);
    expect(matchesHost("api.allowed.com.evil.net", "api.allowed.com")).toBe(false);
  });

  test("matches subdomain wildcards only", () => {
    expect(matchesHost("api.allowed.com", "*.allowed.com")).toBe(true);
    expect(matchesHost("allowed.com", "*.allowed.com")).toBe(false);
    expect(matchesHost("notallowed.com", "*.allowed.com")).toBe(false);
  });
});
