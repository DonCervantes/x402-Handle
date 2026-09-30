import { describe, expect, test } from "bun:test";

describe("demo-provider service", () => {
  test("responds to health check", async () => {
    process.env.DEMO_PROVIDER_PUBLIC = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const server = await import("../src/index");
    const res = await server.default.fetch(new Request("http://localhost:5402/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provider: string };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("flovia-demo-fx");
  });
});
