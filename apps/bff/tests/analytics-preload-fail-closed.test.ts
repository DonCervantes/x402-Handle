import { afterEach, describe, expect, test } from "bun:test";
import { createBffHandler } from "../src/http";

const request = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, init);

const originalNodeEnv = process.env.NODE_ENV;
const originalSource = process.env.BFF_ANALYTICS_SOURCE;

const restoreEnv = () => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalSource === undefined) delete process.env.BFF_ANALYTICS_SOURCE;
  else process.env.BFF_ANALYTICS_SOURCE = originalSource;
};

afterEach(() => {
  restoreEnv();
});

// Force the preload to fail by pointing BFF_ANALYTICS_SOURCE at a valid kind
// with an unreachable path, so the json source throws during resolution.
const forcePreloadFailure = () => {
  process.env.BFF_ANALYTICS_SOURCE = "json";
  process.env.BFF_ANALYTICS_JSON_PATH = "/nonexistent/analytics-156-test.json";
};

describe("#156 fail-closed analytics preload", () => {
  test("production: live-source failure yields 503 on a product route", async () => {
    process.env.NODE_ENV = "production";
    forcePreloadFailure();
    const handler = createBffHandler();
    // allow the preload promise to settle
    await new Promise((r) => setTimeout(r, 50));
    const res = await handler(request("/providers"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body?.error?.code).toBe("analytics_unavailable");
  });

  test("non-production: fixture path is served and provenance is stamped", async () => {
    process.env.NODE_ENV = "test";
    forcePreloadFailure();
    const handler = createBffHandler();
    await new Promise((r) => setTimeout(r, 50));
    const res = await handler(request("/providers"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body?.provenance).toBe("fixture");
  });

  test("production success path is unchanged (no provenance field)", async () => {
    process.env.NODE_ENV = "production";
    process.env.BFF_ANALYTICS_SOURCE = "fixture";
    const handler = createBffHandler();
    await new Promise((r) => setTimeout(r, 50));
    const res = await handler(request("/providers"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body?.provenance).toBeUndefined();
  });
});
