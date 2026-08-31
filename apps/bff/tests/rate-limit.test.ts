import { describe, expect, test, beforeEach } from "bun:test";
import {
  RateLimiter,
  resolveRateLimitConfigs,
  getRateLimitCategory,
  DEFAULT_RATE_LIMITS,
} from "../src/middleware/rate-limit";

describe("Rate limiting middleware", () => {
  describe("resolveRateLimitConfigs", () => {
    test("returns defaults when no environment variables set", () => {
      const configs = resolveRateLimitConfigs({});
      expect(configs).toEqual(DEFAULT_RATE_LIMITS);
    });

    test("parses custom rate limits from environment", () => {
      const configs = resolveRateLimitConfigs({
        BFF_RATE_LIMIT_PAY_MAX_REQUESTS: "5",
        BFF_RATE_LIMIT_PAY_WINDOW_MS: "30000",
        BFF_RATE_LIMIT_LLM_MAX_REQUESTS: "15",
        BFF_RATE_LIMIT_LLM_WINDOW_MS: "45000",
        BFF_RATE_LIMIT_REFRESH_MAX_REQUESTS: "2",
        BFF_RATE_LIMIT_REFRESH_WINDOW_MS: "120000",
      });
      expect(configs).toEqual({
        pay: { maxRequests: 5, windowMs: 30000 },
        llm: { maxRequests: 15, windowMs: 45000 },
        refresh: { maxRequests: 2, windowMs: 120000 },
      });
    });
  });

  describe("getRateLimitCategory", () => {
    test("identifies payment endpoints", () => {
      expect(getRateLimitCategory("/stellar/playground/pay")).toBe("pay");
      expect(getRateLimitCategory("/showcase/stripe-mpp/pay")).toBe("pay");
      expect(getRateLimitCategory("/showcase/solana-mpp/pay")).toBe("pay");
    });

    test("identifies LLM endpoints", () => {
      expect(getRateLimitCategory("/customers/0x123/llm/upsell-explanation")).toBe("llm");
      expect(getRateLimitCategory("/customers/0x456/llm/workflow-intent")).toBe("llm");
    });

    test("identifies refresh endpoint", () => {
      expect(getRateLimitCategory("/aeo/x402/refresh")).toBe("refresh");
    });

    test("returns null for non-rate-limited endpoints", () => {
      expect(getRateLimitCategory("/health")).toBeNull();
      expect(getRateLimitCategory("/providers")).toBeNull();
      expect(getRateLimitCategory("/stellar/health")).toBeNull();
    });
  });

  describe("RateLimiter", () => {
    let rateLimiter: RateLimiter;

    beforeEach(() => {
      rateLimiter = new RateLimiter({
        pay: { maxRequests: 3, windowMs: 1000 },
        llm: { maxRequests: 5, windowMs: 1000 },
        refresh: { maxRequests: 2, windowMs: 1000 },
      });
    });

    test("allows requests under the limit", () => {
      const request = new Request("http://localhost:3001/stellar/playground/pay", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.1" },
      });

      expect(rateLimiter.checkRateLimit(request, "pay")).toBeNull();
      expect(rateLimiter.checkRateLimit(request, "pay")).toBeNull();
      expect(rateLimiter.checkRateLimit(request, "pay")).toBeNull();
    });

    test("blocks requests exceeding the limit", () => {
      const request = new Request("http://localhost:3001/stellar/playground/pay", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.1" },
      });

      // Make 3 requests (the limit)
      rateLimiter.checkRateLimit(request, "pay");
      rateLimiter.checkRateLimit(request, "pay");
      rateLimiter.checkRateLimit(request, "pay");

      // 4th request should be blocked
      const response = rateLimiter.checkRateLimit(request, "pay");
      expect(response).not.toBeNull();
      expect(response?.status).toBe(429);
    });

    test("tracks different IPs separately", () => {
      const request1 = new Request("http://localhost:3001/stellar/playground/pay", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.1" },
      });
      const request2 = new Request("http://localhost:3001/stellar/playground/pay", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.2" },
      });

      // Max out IP 1
      rateLimiter.checkRateLimit(request1, "pay");
      rateLimiter.checkRateLimit(request1, "pay");
      rateLimiter.checkRateLimit(request1, "pay");
      expect(rateLimiter.checkRateLimit(request1, "pay")).not.toBeNull();

      // IP 2 should still be allowed
      expect(rateLimiter.checkRateLimit(request2, "pay")).toBeNull();
    });

    test("tracks different categories separately", () => {
      const request = new Request("http://localhost:3001/test", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.1" },
      });

      // Max out pay category
      rateLimiter.checkRateLimit(request, "pay");
      rateLimiter.checkRateLimit(request, "pay");
      rateLimiter.checkRateLimit(request, "pay");
      expect(rateLimiter.checkRateLimit(request, "pay")).not.toBeNull();

      // LLM category should still be allowed
      expect(rateLimiter.checkRateLimit(request, "llm")).toBeNull();
    });

    test("includes rate limit headers in 429 response", async () => {
      const request = new Request("http://localhost:3001/stellar/playground/pay", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.1" },
      });

      // Max out the limit
      rateLimiter.checkRateLimit(request, "pay");
      rateLimiter.checkRateLimit(request, "pay");
      rateLimiter.checkRateLimit(request, "pay");

      const response = rateLimiter.checkRateLimit(request, "pay");
      expect(response?.headers.get("X-RateLimit-Limit")).toBe("3");
      expect(response?.headers.get("Retry-After")).toBeTruthy();
      
      const body = await response?.json();
      expect(body).toMatchObject({
        error: "rate_limit_exceeded",
      });
    });

    test("resets window after expiry", async () => {
      const request = new Request("http://localhost:3001/stellar/playground/pay", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.1" },
      });

      // Max out the limit
      rateLimiter.checkRateLimit(request, "pay");
      rateLimiter.checkRateLimit(request, "pay");
      rateLimiter.checkRateLimit(request, "pay");
      expect(rateLimiter.checkRateLimit(request, "pay")).not.toBeNull();

      // Wait for window to expire (1 second + buffer)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be allowed again
      expect(rateLimiter.checkRateLimit(request, "pay")).toBeNull();
    });

    test("tracks per-token rate limits for refresh endpoint", () => {
      const request1 = new Request("http://localhost:3001/aeo/x402/refresh", {
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.1",
          authorization: "Bearer token123",
        },
      });
      const request2 = new Request("http://localhost:3001/aeo/x402/refresh", {
        method: "POST",
        headers: {
          "x-forwarded-for": "192.168.1.1",
          authorization: "Bearer token456",
        },
      });

      // Max out token1 (limit is 2)
      rateLimiter.checkRateLimit(request1, "refresh");
      rateLimiter.checkRateLimit(request1, "refresh");
      expect(rateLimiter.checkRateLimit(request1, "refresh")).not.toBeNull();

      // token2 should still be allowed (different token)
      expect(rateLimiter.checkRateLimit(request2, "refresh")).toBeNull();
    });

    test("extracts IP from X-Real-IP header", () => {
      const request = new Request("http://localhost:3001/stellar/playground/pay", {
        method: "POST",
        headers: { "x-real-ip": "10.0.0.1" },
      });

      rateLimiter.checkRateLimit(request, "pay");
      rateLimiter.checkRateLimit(request, "pay");
      rateLimiter.checkRateLimit(request, "pay");
      expect(rateLimiter.checkRateLimit(request, "pay")).not.toBeNull();
    });

    test("cleanup removes expired entries", async () => {
      const request = new Request("http://localhost:3001/stellar/playground/pay", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.1" },
      });

      // Make some requests
      rateLimiter.checkRateLimit(request, "pay");
      const sizeBefore = rateLimiter.getStoreSizes().ipStore;
      expect(sizeBefore).toBeGreaterThan(0);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Manually trigger cleanup
      rateLimiter["cleanup"]();

      const sizeAfter = rateLimiter.getStoreSizes().ipStore;
      expect(sizeAfter).toBe(0);
    });
  });
});
