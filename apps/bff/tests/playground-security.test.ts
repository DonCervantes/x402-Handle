import { afterEach, describe, expect, test } from "bun:test";
import { createPlaygroundRateLimiter } from "../src/data/playground-security";
import { createBffHandler } from "../src/http";

const playgroundEnvNames = [
  "BFF_STELLAR_PLAYGROUND_ENABLED",
  "BFF_STELLAR_PLAYGROUND_API_KEY",
  "BFF_PLAYGROUND_MAX_REQUESTS_PER_DAY",
  "DEMO_AGENT_SECRET",
] as const;
const originalPlaygroundEnv = new Map(
  playgroundEnvNames.map((name) => [name, process.env[name]] as const),
);

const configurePlayground = () => {
  process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
  process.env.BFF_STELLAR_PLAYGROUND_API_KEY = "test-api-key";
  process.env.BFF_PLAYGROUND_MAX_REQUESTS_PER_DAY = "1";
  process.env.DEMO_AGENT_SECRET = "test-demo-secret";
};

const postPayment = (ip: string, authorization?: string) =>
  new Request("http://localhost/stellar/playground/pay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...(authorization ? { authorization } : {}),
    },
    body: "{}",
  });

describe("Stellar playground payment security", () => {
  afterEach(() => {
    for (const [name, value] of originalPlaygroundEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("is disabled unless explicitly enabled", async () => {
    delete process.env.BFF_STELLAR_PLAYGROUND_ENABLED;
    const response = await createBffHandler(new Promise<never>(() => {}))(
      postPayment("198.51.100.1"),
    );

    expect(response.status).toBe(403);
  });

  test("requires the configured API key and demo secret", async () => {
    configurePlayground();
    const handler = createBffHandler(new Promise<never>(() => {}));

    const unauthenticated = await handler(postPayment("198.51.100.1"));
    expect(unauthenticated.status).toBe(401);

    delete process.env.BFF_STELLAR_PLAYGROUND_API_KEY;
    const missingApiKey = await handler(postPayment("198.51.100.1"));
    expect(missingApiKey.status).toBe(503);

    process.env.BFF_STELLAR_PLAYGROUND_API_KEY = "test-api-key";
    delete process.env.DEMO_AGENT_SECRET;
    const unconfigured = await handler(postPayment("198.51.100.1", "Bearer test-api-key"));
    expect(unconfigured.status).toBe(503);
  });

  test("applies a separate daily cap per IP and resets it on the next UTC day", () => {
    const rateLimit = createPlaygroundRateLimiter();
    const firstRequest = new Date("2026-11-19T10:00:00.000Z");

    expect(rateLimit("198.51.100.1", 1, firstRequest)).toBeNull();
    expect(rateLimit("198.51.100.1", 1, firstRequest)).toBeGreaterThan(0);
    expect(rateLimit("198.51.100.2", 1, firstRequest)).toBeNull();
    expect(rateLimit("198.51.100.1", 1, new Date("2026-11-20T00:00:00.000Z"))).toBeNull();
  });

  test("returns 429 after the authenticated IP reaches its daily cap", async () => {
    configurePlayground();
    const handler = createBffHandler(new Promise<never>(() => {}));
    const authorization = "Bearer test-api-key";

    const firstRequest = await handler(postPayment("198.51.100.1", authorization));
    const rateLimited = await handler(postPayment("198.51.100.1", authorization));
    const anotherIp = await handler(postPayment("198.51.100.2", authorization));

    expect(firstRequest.status).toBe(400);
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("retry-after")).toBeTruthy();
    expect(anotherIp.status).toBe(400);
  });
});
