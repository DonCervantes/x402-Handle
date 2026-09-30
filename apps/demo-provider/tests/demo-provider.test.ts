import { describe, expect, test } from "bun:test";

describe("demo-provider service", () => {
  const TEST_DESTINATION = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  test("responds 200 OK to unauthenticated health check", async () => {
    process.env.DEMO_PROVIDER_PUBLIC = TEST_DESTINATION;
    const server = await import("../src/index");
    const res = await server.default.fetch(new Request("http://localhost:5402/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provider: string };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("flovia-demo-fx");
  });

  test("challenges unauthenticated protected /api/rate requests with HTTP 402 Payment Required", async () => {
    process.env.DEMO_PROVIDER_PUBLIC = TEST_DESTINATION;
    const server = await import("../src/index");
    const res = await server.default.fetch(new Request("http://localhost:5402/api/rate"));
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      version: string;
      network: string;
      asset: { code: string; issuer: string };
      amount: string;
      destination: string;
      memo: string;
      expires_at: string;
    };
    expect(body.version).toBe("x402-stellar-1");
    expect(body.asset.code).toBe("USDC");
    expect(body.amount).toBe("0.005");
    expect(body.destination).toBe(TEST_DESTINATION);
    expect(body.memo).toMatch(/^fl-/);
  });
});
