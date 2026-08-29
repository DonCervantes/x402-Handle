import { describe, expect, test } from "bun:test";
import {
  applyCorsHeaders,
  createCorsOptions,
  handleCorsPreFlight,
  resolveAllowedOrigins,
  wrapResponseWithCors,
} from "../src/middleware/cors";

describe("CORS middleware", () => {
  describe("resolveAllowedOrigins", () => {
    test("returns defaults when BFF_CORS_ALLOWED_ORIGINS is not set", () => {
      const origins = resolveAllowedOrigins({});
      expect(origins).toEqual([
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
      ]);
    });

    test("parses comma-separated origins from environment", () => {
      const origins = resolveAllowedOrigins({
        BFF_CORS_ALLOWED_ORIGINS: "https://app.example.com,https://staging.example.com",
      });
      expect(origins).toEqual(["https://app.example.com", "https://staging.example.com"]);
    });

    test("trims whitespace from origins", () => {
      const origins = resolveAllowedOrigins({
        BFF_CORS_ALLOWED_ORIGINS: " https://app.example.com , https://staging.example.com ",
      });
      expect(origins).toEqual(["https://app.example.com", "https://staging.example.com"]);
    });

    test("filters empty origins", () => {
      const origins = resolveAllowedOrigins({
        BFF_CORS_ALLOWED_ORIGINS: "https://app.example.com,,https://staging.example.com",
      });
      expect(origins).toEqual(["https://app.example.com", "https://staging.example.com"]);
    });
  });

  describe("applyCorsHeaders", () => {
    const options = createCorsOptions({
      BFF_CORS_ALLOWED_ORIGINS: "https://app.example.com,https://staging.example.com",
    });

    test("returns empty headers when no origin header present", () => {
      const request = new Request("http://localhost:3001/health");
      const headers = applyCorsHeaders(request, options);
      expect(headers).toEqual({});
    });

    test("returns CORS headers for allowed origin", () => {
      const request = new Request("http://localhost:3001/health", {
        headers: { origin: "https://app.example.com" },
      });
      const headers = applyCorsHeaders(request, options);
      expect(headers).toMatchObject({
        "Access-Control-Allow-Origin": "https://app.example.com",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Credentials": "true",
      });
    });

    test("returns null for disallowed origin", () => {
      const request = new Request("http://localhost:3001/health", {
        headers: { origin: "https://evil.com" },
      });
      const headers = applyCorsHeaders(request, options);
      expect(headers).toBeNull();
    });
  });

  describe("handleCorsPreFlight", () => {
    const options = createCorsOptions({
      BFF_CORS_ALLOWED_ORIGINS: "https://app.example.com",
    });

    test("returns 204 with CORS headers for allowed origin", async () => {
      const request = new Request("http://localhost:3001/health", {
        method: "OPTIONS",
        headers: { origin: "https://app.example.com" },
      });
      const response = handleCorsPreFlight(request, options);
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    });

    test("returns 403 for disallowed origin", async () => {
      const request = new Request("http://localhost:3001/health", {
        method: "OPTIONS",
        headers: { origin: "https://evil.com" },
      });
      const response = handleCorsPreFlight(request, options);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Origin not allowed");
    });
  });

  describe("wrapResponseWithCors", () => {
    const options = createCorsOptions({
      BFF_CORS_ALLOWED_ORIGINS: "https://app.example.com",
    });

    test("adds CORS headers to response for allowed origin", () => {
      const request = new Request("http://localhost:3001/health", {
        headers: { origin: "https://app.example.com" },
      });
      const originalResponse = new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const response = wrapResponseWithCors(request, originalResponse, options);
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    test("returns 403 for disallowed origin", () => {
      const request = new Request("http://localhost:3001/health", {
        headers: { origin: "https://evil.com" },
      });
      const originalResponse = new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
      });
      const response = wrapResponseWithCors(request, originalResponse, options);
      expect(response.status).toBe(403);
    });

    test("returns original response when no origin header", () => {
      const request = new Request("http://localhost:3001/health");
      const originalResponse = new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
      });
      const response = wrapResponseWithCors(request, originalResponse, options);
      expect(response).toBe(originalResponse);
    });
  });
});
