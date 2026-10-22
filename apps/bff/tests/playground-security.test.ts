import { describe, expect, test, beforeEach } from "bun:test";
import {
  PlaygroundRateLimiter,
  extractClientIp,
  resolvePlaygroundSecurityConfig,
  validatePlaygroundApiKey,
  type PlaygroundSecurityConfig,
} from "../src/data/playground-security";

describe("PlaygroundRateLimiter", () => {
  let config: PlaygroundSecurityConfig;
  let limiter: PlaygroundRateLimiter;

  beforeEach(() => {
    config = {
      enabled: true,
      apiKey: null,
      maxRequestsPerIpPerHour: 3,
      maxRequestsPerIpPerDay: 5,
    };
    limiter = new PlaygroundRateLimiter(config);
  });

  test("allows requests below hourly limit", () => {
    expect(limiter.checkRateLimit("192.168.1.1")).toBeNull();
    expect(limiter.checkRateLimit("192.168.1.1")).toBeNull();
    expect(limiter.checkRateLimit("192.168.1.1")).toBeNull();
  });

  test("blocks requests exceeding hourly limit", () => {
    limiter.checkRateLimit("192.168.1.1");
    limiter.checkRateLimit("192.168.1.1");
    limiter.checkRateLimit("192.168.1.1");
    const error = limiter.checkRateLimit("192.168.1.1");
    expect(error).toContain("Rate limit exceeded");
    expect(error).toContain("per hour");
  });

  test("blocks requests exceeding daily limit", () => {
    // Use different IPs to avoid hourly limit
    limiter.checkRateLimit("192.168.1.1");
    limiter.checkRateLimit("192.168.1.2");
    limiter.checkRateLimit("192.168.1.3");
    limiter.checkRateLimit("192.168.1.4");
    limiter.checkRateLimit("192.168.1.5");
    
    // All IPs should be at or near daily limit
    const error = limiter.checkRateLimit("192.168.1.1");
    expect(error).toContain("Rate limit exceeded");
    expect(error).toContain("per day");
  });

  test("tracks different IPs independently", () => {
    limiter.checkRateLimit("192.168.1.1");
    limiter.checkRateLimit("192.168.1.1");
    limiter.checkRateLimit("192.168.1.1");

    // Different IP should still be allowed
    expect(limiter.checkRateLimit("192.168.1.2")).toBeNull();
  });

  test("returns current usage for an IP", () => {
    limiter.checkRateLimit("192.168.1.1");
    limiter.checkRateLimit("192.168.1.1");

    const usage = limiter.getUsage("192.168.1.1");
    expect(usage).not.toBeNull();
    expect(usage?.hourly).toBe(2);
    expect(usage?.daily).toBe(2);
  });

  test("returns null usage for unknown IP", () => {
    const usage = limiter.getUsage("10.0.0.1");
    expect(usage).toBeNull();
  });
});

describe("extractClientIp", () => {
  test("extracts IP from X-Forwarded-For header", () => {
    const request = new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.1, 198.51.100.1" },
    });
    expect(extractClientIp(request)).toBe("203.0.113.1");
  });

  test("extracts IP from X-Real-IP header", () => {
    const request = new Request("http://localhost", {
      headers: { "x-real-ip": "203.0.113.1" },
    });
    expect(extractClientIp(request)).toBe("203.0.113.1");
  });

  test("extracts IP from CF-Connecting-IP header", () => {
    const request = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    });
    expect(extractClientIp(request)).toBe("203.0.113.1");
  });

  test("prefers X-Forwarded-For over other headers", () => {
    const request = new Request("http://localhost", {
      headers: {
        "x-forwarded-for": "203.0.113.1",
        "x-real-ip": "198.51.100.1",
      },
    });
    expect(extractClientIp(request)).toBe("203.0.113.1");
  });

  test("returns 'unknown' when no IP headers present", () => {
    const request = new Request("http://localhost");
    expect(extractClientIp(request)).toBe("unknown");
  });
});

describe("validatePlaygroundApiKey", () => {
  test("allows request when no API key is configured", () => {
    const request = new Request("http://localhost");
    expect(validatePlaygroundApiKey(request, null)).toBe(true);
  });

  test("validates Bearer token in Authorization header", () => {
    const request = new Request("http://localhost", {
      headers: { authorization: "Bearer secret-key-123" },
    });
    expect(validatePlaygroundApiKey(request, "secret-key-123")).toBe(true);
    expect(validatePlaygroundApiKey(request, "wrong-key")).toBe(false);
  });

  test("validates X-API-Key header", () => {
    const request = new Request("http://localhost", {
      headers: { "x-api-key": "secret-key-123" },
    });
    expect(validatePlaygroundApiKey(request, "secret-key-123")).toBe(true);
    expect(validatePlaygroundApiKey(request, "wrong-key")).toBe(false);
  });

  test("rejects request without API key when one is required", () => {
    const request = new Request("http://localhost");
    expect(validatePlaygroundApiKey(request, "required-key")).toBe(false);
  });

  test("handles Bearer token case-insensitively", () => {
    const request = new Request("http://localhost", {
      headers: { authorization: "BEARER secret-key-123" },
    });
    expect(validatePlaygroundApiKey(request, "secret-key-123")).toBe(true);
  });

  test("trims whitespace from tokens", () => {
    const request = new Request("http://localhost", {
      headers: { authorization: "Bearer  secret-key-123  " },
    });
    expect(validatePlaygroundApiKey(request, "secret-key-123")).toBe(true);
  });
});

describe("resolvePlaygroundSecurityConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  test("defaults to disabled", () => {
    delete process.env.BFF_STELLAR_PLAYGROUND_ENABLED;
    const config = resolvePlaygroundSecurityConfig();
    expect(config.enabled).toBe(false);
  });

  test("enables when explicitly set to true", () => {
    process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "true";
    const config = resolvePlaygroundSecurityConfig();
    expect(config.enabled).toBe(true);
  });

  test("remains disabled for other values", () => {
    process.env.BFF_STELLAR_PLAYGROUND_ENABLED = "yes";
    const config = resolvePlaygroundSecurityConfig();
    expect(config.enabled).toBe(false);
  });

  test("reads API key from environment", () => {
    process.env.BFF_STELLAR_PLAYGROUND_API_KEY = "test-key-123";
    const config = resolvePlaygroundSecurityConfig();
    expect(config.apiKey).toBe("test-key-123");
  });

  test("uses default rate limits when not specified", () => {
    const config = resolvePlaygroundSecurityConfig();
    expect(config.maxRequestsPerIpPerHour).toBe(10);
    expect(config.maxRequestsPerIpPerDay).toBe(50);
  });

  test("reads custom rate limits from environment", () => {
    process.env.BFF_PLAYGROUND_MAX_REQUESTS_PER_HOUR = "5";
    process.env.BFF_PLAYGROUND_MAX_REQUESTS_PER_DAY = "25";
    const config = resolvePlaygroundSecurityConfig();
    expect(config.maxRequestsPerIpPerHour).toBe(5);
    expect(config.maxRequestsPerIpPerDay).toBe(25);
  });

  test("uses defaults for invalid rate limit values", () => {
    process.env.BFF_PLAYGROUND_MAX_REQUESTS_PER_HOUR = "invalid";
    process.env.BFF_PLAYGROUND_MAX_REQUESTS_PER_DAY = "-10";
    const config = resolvePlaygroundSecurityConfig();
    expect(config.maxRequestsPerIpPerHour).toBe(10);
    expect(config.maxRequestsPerIpPerDay).toBe(50);
  });
});
