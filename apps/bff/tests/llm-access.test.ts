import { describe, expect, test } from "bun:test";
import { fixtureAnalyticsDataSource } from "../src/data/analytics-source";
import { createBffHandler } from "../src/http";
import { createLlmAccessGuard, resolveLlmAccessConfig } from "../src/http/llm-access";
import { knownCustomerIntelligenceAddress } from "../src/data/phase-b-demo";

const upsellMetricsPath = `/customers/${knownCustomerIntelligenceAddress}/llm/upsell-metrics`;
const upsellExplanationPath = `/customers/${knownCustomerIntelligenceAddress}/llm/upsell-explanation`;
const workflowIntentPath = `/customers/${knownCustomerIntelligenceAddress}/llm/workflow-intent`;

const llmRequest = (path: string, token?: string) =>
  new Request(`http://localhost${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const makeHandler = (apiKey: string | null, maxCalls = 2, now?: () => number) =>
  createBffHandler(
    fixtureAnalyticsDataSource,
    null,
    undefined,
    undefined,
    createLlmAccessGuard({ apiKey, maxCalls, windowMs: 1000, now }),
  );

describe("LLM route credential", () => {
  test("401 when the credential is missing", async () => {
    const response = await makeHandler("test-key")(llmRequest(upsellMetricsPath));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  test("401 when the credential is wrong", async () => {
    const response = await makeHandler("test-key")(llmRequest(upsellMetricsPath, "wrong-key"));
    expect(response.status).toBe(401);
  });

  test("accepts an x-api-key credential", async () => {
    const response = await makeHandler("test-key")(
      new Request(`http://localhost${upsellMetricsPath}`, {
        headers: { "x-api-key": "test-key" },
      }),
    );
    expect(response.status).toBe(200);
  });

  test("403 when no credential is configured for the environment", async () => {
    const response = await makeHandler(null)(llmRequest(upsellMetricsPath, "test-key"));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe("forbidden");
  });

  test("guards every LLM/upsell route, not just upsell metrics", async () => {
    const handler = makeHandler("test-key");

    for (const path of [upsellMetricsPath, upsellExplanationPath, workflowIntentPath]) {
      expect((await handler(llmRequest(path))).status, path).toBe(401);
    }
  });

  test("leaves public customer routes open", async () => {
    const response = await makeHandler("test-key")(llmRequest("/customers"));
    expect(response.status).toBe(200);
  });

  test("serves a valid credential on an LLM route", async () => {
    const response = await makeHandler("test-key")(llmRequest(upsellMetricsPath, "test-key"));
    expect(response.status).toBe(200);
  });
});

describe("LLM route rate limit", () => {
  test("429 with retry-after once the per-credential quota is exhausted", async () => {
    const handler = makeHandler("test-key");

    expect((await handler(llmRequest(upsellMetricsPath, "test-key"))).status).toBe(200);
    expect((await handler(llmRequest(upsellMetricsPath, "test-key"))).status).toBe(200);

    const response = await handler(llmRequest(upsellMetricsPath, "test-key"));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(body.error).toBe("rate_limited");
  });

  test("resets the quota after the window elapses", async () => {
    let clock = 1000;
    const handler = makeHandler("test-key", 1, () => clock);

    expect((await handler(llmRequest(upsellMetricsPath, "test-key"))).status).toBe(200);
    expect((await handler(llmRequest(upsellMetricsPath, "test-key"))).status).toBe(429);

    clock += 1000;
    expect((await handler(llmRequest(upsellMetricsPath, "test-key"))).status).toBe(200);
  });

  test("shares one quota across all LLM routes", async () => {
    const handler = makeHandler("test-key", 1);

    expect((await handler(llmRequest(upsellMetricsPath, "test-key"))).status).toBe(200);
    expect((await handler(llmRequest(upsellExplanationPath, "test-key"))).status).toBe(429);
  });
});

describe("LLM access configuration", () => {
  test("reads credential and quota limits from the environment", () => {
    expect(
      resolveLlmAccessConfig({
        BFF_LLM_API_KEY: "secret",
        BFF_LLM_RATE_LIMIT_MAX: "3",
        BFF_LLM_RATE_LIMIT_WINDOW_MS: "500",
      }),
    ).toEqual({ apiKey: "secret", maxCalls: 3, windowMs: 500 });
  });

  test("falls back to safe defaults for missing or invalid limits", () => {
    expect(resolveLlmAccessConfig({})).toEqual({
      apiKey: null,
      maxCalls: 60,
      windowMs: 60_000,
    });
    expect(
      resolveLlmAccessConfig({ BFF_LLM_RATE_LIMIT_MAX: "0", BFF_LLM_RATE_LIMIT_WINDOW_MS: "-5" }),
    ).toEqual({ apiKey: null, maxCalls: 60, windowMs: 60_000 });
  });
});
