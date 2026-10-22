import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createBffHandler } from "../src/http";
import type { PlaygroundSecurityConfig } from "../src/data/playground-security";

const PLAYGROUND_PATH = "/stellar/playground/pay";

function createRequest(
  body: unknown = { providerId: "cdp/fx-rates-oracle" },
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost${PLAYGROUND_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("Playground endpoint security", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Kill-switch (BFF_STELLAR_PLAYGROUND_ENABLED)", () => {
    test("returns 403 when playground is disabled (default)", async () => {
      delete process.env.BFF_STELLAR_PLAYGROUND_ENABLED;
      const handler = createBffHandler(undefined, null, undefined, undefined);
      const response = await handler(createRequest());

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("playground_disabled");
      expect(body.message).toContain("disabled");
    });

    test("allows request when explicitly enabled", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      process.env.DEMO_AGENT_SECRET = "test-secret";
      
      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: null,
        maxRequestsPerIpPerHour: 100,
        maxRequestsPerIpPerDay: 500,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      const response = await handler(createRequest());

      // Should not be 403 (disabled) - will be other error since we're not fully configured
      expect(response.status).not.toBe(403);
    });
  });

  describe("Fail-closed when DEMO_AGENT_SECRET missing", () => {
    test("returns 503 when secret is missing but playground is enabled", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      delete process.env.DEMO_AGENT_SECRET;

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: null,
        maxRequestsPerIpPerHour: 100,
        maxRequestsPerIpPerDay: 500,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      const response = await handler(createRequest());

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("playground_misconfigured");
      expect(body.message).toContain("DEMO_AGENT_SECRET");
    });

    test("checks secret before processing request body", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      delete process.env.DEMO_AGENT_SECRET;

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: null,
        maxRequestsPerIpPerHour: 100,
        maxRequestsPerIpPerDay: 500,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      // Send malformed body - should fail at secret check, not body parse
      const response = await handler(createRequest({ invalid: "data" }));

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("playground_misconfigured");
    });
  });

  describe("API key authentication", () => {
    test("returns 401 when API key is required but missing", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      process.env.DEMO_AGENT_SECRET = "test-secret";

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: "required-api-key",
        maxRequestsPerIpPerHour: 100,
        maxRequestsPerIpPerDay: 500,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      const response = await handler(createRequest());

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("unauthorized");
      expect(body.message).toContain("API key");
    });

    test("returns 401 when API key is incorrect", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      process.env.DEMO_AGENT_SECRET = "test-secret";

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: "correct-key",
        maxRequestsPerIpPerHour: 100,
        maxRequestsPerIpPerDay: 500,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      const response = await handler(
        createRequest(undefined, { authorization: "Bearer wrong-key" }),
      );

      expect(response.status).toBe(401);
    });

    test("allows request with correct Bearer token", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      process.env.DEMO_AGENT_SECRET = "test-secret";

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: "correct-key",
        maxRequestsPerIpPerHour: 100,
        maxRequestsPerIpPerDay: 500,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      const response = await handler(
        createRequest(undefined, { authorization: "Bearer correct-key" }),
      );

      // Should pass auth check (will fail later due to provider not found, etc.)
      expect(response.status).not.toBe(401);
    });

    test("allows request with correct X-API-Key header", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      process.env.DEMO_AGENT_SECRET = "test-secret";

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: "correct-key",
        maxRequestsPerIpPerHour: 100,
        maxRequestsPerIpPerDay: 500,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      const response = await handler(
        createRequest(undefined, { "x-api-key": "correct-key" }),
      );

      // Should pass auth check
      expect(response.status).not.toBe(401);
    });
  });

  describe("Rate limiting", () => {
    test("returns 429 when IP exceeds hourly limit", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      process.env.DEMO_AGENT_SECRET = "test-secret";

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: null,
        maxRequestsPerIpPerHour: 2,
        maxRequestsPerIpPerDay: 10,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);

      // Make requests with same IP
      const headers = { "x-forwarded-for": "203.0.113.1" };
      await handler(createRequest(undefined, headers));
      await handler(createRequest(undefined, headers));
      const response = await handler(createRequest(undefined, headers));

      expect(response.status).toBe(429);
      const body = (await response.json()) as { error: string; message: string; clientIp: string };
      expect(body.error).toBe("rate_limit_exceeded");
      expect(body.message).toContain("per hour");
      expect(body.clientIp).toBe("203.0.113.1");
    });

    test("allows requests from different IPs independently", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      process.env.DEMO_AGENT_SECRET = "test-secret";

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: null,
        maxRequestsPerIpPerHour: 2,
        maxRequestsPerIpPerDay: 10,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);

      // Exhaust limit for IP1
      await handler(createRequest(undefined, { "x-forwarded-for": "203.0.113.1" }));
      await handler(createRequest(undefined, { "x-forwarded-for": "203.0.113.1" }));

      // IP2 should still be allowed
      const response = await handler(
        createRequest(undefined, { "x-forwarded-for": "203.0.113.2" }),
      );
      expect(response.status).not.toBe(429);
    });
  });

  describe("Security control order", () => {
    test("checks kill-switch before secret", async () => {
      delete process.env.BFF_STELLAR_PLAYGROUND_ENABLED;
      delete process.env.DEMO_AGENT_SECRET;

      const handler = createBffHandler(undefined, null, undefined, undefined);
      const response = await handler(createRequest());

      // Should fail at kill-switch (403), not missing secret (503)
      expect(response.status).toBe(403);
    });

    test("checks secret before API key", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      delete process.env.DEMO_AGENT_SECRET;

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: "required-key",
        maxRequestsPerIpPerHour: 100,
        maxRequestsPerIpPerDay: 500,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      const response = await handler(createRequest());

      // Should fail at secret check (503), not API key (401)
      expect(response.status).toBe(503);
    });

    test("checks API key before rate limiting", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      process.env.DEMO_AGENT_SECRET = "test-secret";

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: "required-key",
        maxRequestsPerIpPerHour: 0, // Would immediately rate limit
        maxRequestsPerIpPerDay: 0,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      const response = await handler(createRequest());

      // Should fail at API key (401), not rate limit (429)
      expect(response.status).toBe(401);
    });
  });

  describe("Request validation", () => {
    test("returns 400 when providerId is missing", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      process.env.DEMO_AGENT_SECRET = "test-secret";

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: null,
        maxRequestsPerIpPerHour: 100,
        maxRequestsPerIpPerDay: 500,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      const response = await handler(createRequest({}));

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.message).toContain("providerId");
    });

    test("returns 400 when body is malformed", async () => {
      process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
      process.env.DEMO_AGENT_SECRET = "test-secret";

      const securityConfig: PlaygroundSecurityConfig = {
        enabled: true,
        apiKey: null,
        maxRequestsPerIpPerHour: 100,
        maxRequestsPerIpPerDay: 500,
      };

      const handler = createBffHandler(undefined, null, undefined, undefined, securityConfig);
      
      const request = new Request(`http://localhost${PLAYGROUND_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "invalid json{",
      });

      const response = await handler(request);
      expect(response.status).toBe(400);
    });
  });
});
