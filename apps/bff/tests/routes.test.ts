import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBffHandler } from "../src/http";
import {
  applyMppCatalogOverlay,
  fixtureAnalyticsDataSource,
  isSolanaCustomer,
  loadGeneratedAnalyticsDataSource,
  loadPostgresAnalyticsDataSource,
  persistPostgresLiveAnalyticsSnapshot,
  resolveAnalyticsDataSource,
  shouldTagPaySh,
} from "../src/data/analytics-source";
import { loadPostgresLiveAnalyticsDataSource } from "../src/data/postgres-live-read-model";
import type { BffLlmService } from "../src/data/llm";
import {
  joinedPhaseBProjectionRecords,
  knownCustomerIntelligenceAddress,
  knownCustomerProfileAddress,
  phaseBCustomerListResponse,
  serviceAnalyticsSummaryResponse,
} from "../src/data/phase-b-demo";
import transactionFixture from "../fixtures/phase-a/coingecko-transactions.json";
import attributionFixture from "../fixtures/phase-b/mock-attribution.json";
import { buildPhaseBProjections, joinTransactionAttribution } from "../src/data/projection-builder";
import {
  validatePhaseBCustomerWorkflowIntentResponse,
  validatePhaseBCustomerUpsellMetricsResponse,
  validatePhaseBCustomerUpsellExplanationResponse,
  validatePhaseBCustomerListResponse,
  validatePhaseBCustomerProfileResponse,
  validatePhaseBWalletUsageGraphResponse,
  validateMockEndpointAttributionFixture,
  validateCustomerIntelligenceResponse,
  validateProviderCatalogResponse,
  validateRealTransactionFixture,
  validateServiceAnalyticsComparisonResponse,
  validateServiceAnalyticsQuadrantResponse,
  validateServiceAnalyticsSummaryResponse,
  validateRouteAnalyticsSankeyResponse,
  validateRouteAnalyticsSummaryResponse,
} from "contracts";

const request = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, init);

const originalAnalyticsSource = process.env.BFF_ANALYTICS_SOURCE;
const runtimeMetadata = {
  commitHash: "abc123def456",
  startedAt: "2026-05-08T10:11:12.000Z",
};

const expectMemoryUsageBody = (memory: unknown) => {
  expect(memory).toEqual({
    rss: expect.any(Number),
    heapTotal: expect.any(Number),
    heapUsed: expect.any(Number),
    external: expect.any(Number),
    arrayBuffers: expect.any(Number),
  });
};

const withTempFile = async (fn: (filePath: string) => Promise<void> | void) => {
  const directory = path.join(process.cwd(), "tmp", `bff-read-model-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    await Promise.resolve(fn(path.join(directory, "analytics.json")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
const llmEnvKeys = [
  "BFF_LLM_PROVIDER",
  "BFF_BEDROCK_MODEL_ID",
  "BEDROCK_MODEL_ID",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "BFF_QVAC_MODEL_SRC",
  "BFF_QVAC_MODEL_ID",
  "BFF_QVAC_DEVICE",
  "BFF_QVAC_CTX_SIZE",
  "BFF_LLM_PROMPT_VERSION",
  "BFF_BEDROCK_PROMPT_VERSION",
  "BFF_WORKFLOW_INTENT_PROMPT_VERSION",
  "BFF_LLM_CACHE_DIR",
  "BFF_LLM_CACHE_TTL_MS",
  "BFF_BRANCH_NAME",
  "BFF_DEPLOY_ID",
  "HOSTNAME",
  "DATABASE_URL",
] as const;

const snapshotLlmEnv = () =>
  Object.fromEntries(llmEnvKeys.map((key) => [key, process.env[key]])) as Record<
    (typeof llmEnvKeys)[number],
    string | undefined
  >;

const clearLlmEnv = () => {
  for (const key of llmEnvKeys) {
    delete process.env[key];
  }
};

const restoreLlmEnv = (snapshot: Record<(typeof llmEnvKeys)[number], string | undefined>) => {
  for (const key of llmEnvKeys) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
};

const workflowIntentAddress = "0x0000000000000000000000000000000000000abc";
const workflowIntentProfile = validatePhaseBCustomerProfileResponse({
  generatedAt: "2026-05-01T00:00:00Z",
  generatedFrom: "workflow-intent-test",
  provenance: "derived_insight",
  reasons: [{ provenance: "derived_insight", label: "workflow intent fixture" }],
  profile: {
    identity: {
      address: workflowIntentAddress,
      label: null,
      network: "base",
      asset: "USDC",
      role: "payer_wallet",
      identityBasis: "wallet_address",
      caveat: null,
      provenance: "onchain_fact",
      provenanceByField: { address: "onchain_fact" },
    },
    metrics: {
      spendAtomic: "900",
      activityGrowth: 0.4,
      freeTierProgress: 0.3,
      entryPointRatio: 0.5,
      upsellOpportunity: "medium",
      provenance: "derived_insight",
      provenanceByField: { spendAtomic: "onchain_fact" },
      reasons: [{ provenance: "derived_insight", label: "workflow intent metrics" }],
    },
    providers: [
      {
        providerId: "price-api",
        name: "Price API",
        payToWallet: "0x0000000000000000000000000000000000000011",
        spendAtomic: "300",
        transactionCount: 2,
        confidence: 0.8,
        provenance: "derived_insight",
        provenanceByField: { payToWallet: "onchain_fact" },
        reasons: [{ provenance: "derived_insight", label: "workflow intent provider" }],
      },
      {
        providerId: "llm-api",
        name: "LLM API",
        payToWallet: "0x0000000000000000000000000000000000000022",
        spendAtomic: "600",
        transactionCount: 2,
        confidence: 0.8,
        provenance: "derived_insight",
        provenanceByField: { payToWallet: "onchain_fact" },
        reasons: [{ provenance: "derived_insight", label: "workflow intent provider" }],
      },
    ],
    timeline: [
      {
        at: "2026-05-01T10:00:00Z",
        eventType: "payment",
        description: "Price refresh: GET /v1/price",
        amountAtomic: "100",
        relatedProviderId: "price-api",
        provenance: "derived_insight",
        provenanceByField: { amountAtomic: "onchain_fact" },
        reasons: [{ provenance: "derived_insight", label: "workflow intent event" }],
      },
      {
        at: "2026-05-01T10:02:00Z",
        eventType: "payment",
        description: "Strategy eval: POST /v1/responses",
        amountAtomic: "200",
        relatedProviderId: "llm-api",
        provenance: "derived_insight",
        provenanceByField: { amountAtomic: "onchain_fact" },
        reasons: [{ provenance: "derived_insight", label: "workflow intent event" }],
      },
      {
        at: "2026-05-01T10:04:00Z",
        eventType: "payment",
        description: "Execution check: GET /v1/quote",
        amountAtomic: "300",
        relatedProviderId: "price-api",
        provenance: "derived_insight",
        provenanceByField: { amountAtomic: "onchain_fact" },
        reasons: [{ provenance: "derived_insight", label: "workflow intent event" }],
      },
    ],
    insights: [],
    provenance: "derived_insight",
    provenanceByField: { timeline: "derived_insight" },
    reasons: [{ provenance: "derived_insight", label: "workflow intent profile" }],
  },
});

describe("BFF routes", () => {
  let llmEnvSnapshot: Record<(typeof llmEnvKeys)[number], string | undefined>;

  beforeAll(() => {
    process.env.BFF_ANALYTICS_SOURCE = "fixture";
  });

  beforeEach(() => {
    llmEnvSnapshot = snapshotLlmEnv();
    clearLlmEnv();
  });

  afterEach(() => {
    restoreLlmEnv(llmEnvSnapshot);
  });

  afterAll(() => {
    if (originalAnalyticsSource === undefined) {
      delete process.env.BFF_ANALYTICS_SOURCE;
      return;
    }
    process.env.BFF_ANALYTICS_SOURCE = originalAnalyticsSource;
  });

  test("serves minimal read-only endpoints", async () => {
    const handler = createBffHandler();

    for (const path of ["/", "/health"] as const) {
      const response = await handler(request(path));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toContain("application/json");
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ service: "flovia-bff", status: "ok" }),
      );
    }
  });

  test("serves health without waiting for analytics data source", async () => {
    const unresolvedDataSource = new Promise<never>(() => { });
    const handler = createBffHandler(unresolvedDataSource, null, runtimeMetadata);

    const response = await handler(request("/health"));

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({
      status: "ok",
      service: "flovia-bff",
      commitHash: runtimeMetadata.commitHash,
      startedAt: runtimeMetadata.startedAt,
      memory: expect.any(Object),
      analyticsStatus: "loading",
    });
    expectMemoryUsageBody(body.memory);
  });

  test("reports readiness only after analytics data source is loaded", async () => {
    const unresolvedDataSource = new Promise<never>(() => { });
    const handler = createBffHandler(unresolvedDataSource, null, runtimeMetadata);

    const response = await handler(request("/ready"));
    const body = (await response.json()) as {
      status: string;
      service: string;
      analyticsStatus: string;
    };

    expect(response.status).toBe(503);
    expect(body).toEqual({
      status: "loading",
      service: "flovia-bff",
      analyticsStatus: "loading",
    });
  });

  test("does not block providers while analytics data source is loading", async () => {
    const unresolvedDataSource = new Promise<never>(() => { });
    const handler = createBffHandler(unresolvedDataSource, null, runtimeMetadata);

    const response = await handler(request("/providers"));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(503);
    expect(body.error).toBe("analytics_loading");
  });

  test("fails closed in production when preload falls back to fixture analytics", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const handler = createBffHandler(
        Promise.reject(new Error("snapshot unavailable")),
        null,
        runtimeMetadata,
      );
      await Promise.resolve();

      const readyResponse = await handler(request("/ready"));
      const readyBody = (await readyResponse.json()) as {
        status: string;
        service: string;
        analyticsStatus: string;
        analyticsSource?: string;
      };
      const providersResponse = await handler(request("/providers"));
      const providersBody = await providersResponse.json();

      expect(readyResponse.status).toBe(200);
      expect(readyBody).toEqual({
        status: "ok",
        service: "flovia-bff",
        analyticsStatus: "fallback",
        analyticsSource: "fixture",
      });
      expect(providersResponse.status).toBe(503);
      expect(providersBody).toEqual(
        expect.objectContaining({
          error: "analytics_unavailable",
          message: "Analytics preload failed.",
        }),
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  test("serves health without resolving the default analytics source", async () => {
    process.env.BFF_ANALYTICS_SOURCE = "postgres";
    delete process.env.BFF_ANALYTICS_DATABASE_URL;

    try {
      const handler = createBffHandler(undefined, null, runtimeMetadata);
      const response = await handler(request("/health"));

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body).toEqual({
        status: "ok",
        service: "flovia-bff",
        commitHash: runtimeMetadata.commitHash,
        startedAt: runtimeMetadata.startedAt,
        memory: expect.any(Object),
        analyticsStatus: "fallback",
      });
      expectMemoryUsageBody(body.memory);
    } finally {
      process.env.BFF_ANALYTICS_SOURCE = "fixture";
    }
  });

  test("serves health with runtime metadata", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource, null, runtimeMetadata);
    const response = await handler(request("/health"));

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({
      status: "ok",
      service: "flovia-bff",
      commitHash: runtimeMetadata.commitHash,
      startedAt: runtimeMetadata.startedAt,
      memory: expect.any(Object),
      analyticsStatus: "ready",
    });
    expectMemoryUsageBody(body.memory);
  });

  test("rejects non-GET requests to read-only endpoints", async () => {
    const handler = createBffHandler();
    const response = await handler(request("/health", { method: "POST" }));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(405);
    expect(body.error).toBe("method_not_allowed");
  });

  test("returns JSON not found for unsupported routes", async () => {
    const handler = createBffHandler();
    const response = await handler(request("/unknown"));
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("/unknown");
  });

  test("serves customer list with schema validation", async () => {
    const handler = createBffHandler();

    const response = await handler(request("/customers"));
    const body = await response.json();
    const parsed = validatePhaseBCustomerListResponse(body);

    expect(response.status).toBe(200);
    expect(parsed.customerCount).toBe(parsed.customers.length);
    expect(parsed.customerCount).toBeGreaterThan(0);
  });

  test("serves provider catalog with schema validation", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);

    const response = await handler(request("/providers"));
    const parsed = validateProviderCatalogResponse(await response.json());

    expect(response.status).toBe(200);
    expect(parsed.providerCount).toBe(parsed.providers.length);
    expect(parsed.providers.some((provider) => provider.hasCustomerFacts)).toBe(true);
  });

  test("omits heavy per-endpoint resources from the provider list", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);

    const response = await handler(request("/providers"));
    const parsed = validateProviderCatalogResponse(await response.json());

    expect(response.status).toBe(200);
    // The list endpoint must not carry the heavy `resources` array (it inflated
    // the payload ~50x); the summary `resourceCount` is retained for callers.
    expect(parsed.providers.every((provider) => provider.resources === undefined)).toBe(true);
    expect(parsed.providers.every((provider) => typeof provider.resourceCount === "number")).toBe(
      true,
    );
  });

  test("serves a single provider by id and 404s unknown ids", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);
    const knownId = fixtureAnalyticsDataSource.providers.providers[0]?.providerId ?? "";

    const found = await handler(request(`/providers/${encodeURIComponent(knownId)}`));
    expect(found.status).toBe(200);
    const row = (await found.json()) as { providerId: string };
    expect(row.providerId).toBe(knownId);

    const missing = await handler(request("/providers/does-not-exist"));
    expect(missing.status).toBe(404);
  });

  test("marks snapshot-backed read endpoints as edge-cacheable", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);

    const response = await handler(request("/providers"));

    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  test("keeps error responses uncacheable", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);

    const response = await handler(request("/unknown"));

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("serves machine payment route analytics summary and sankey", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);

    const summaryResponse = await handler(request("/analytics/routes/summary"));
    const summary = validateRouteAnalyticsSummaryResponse(await summaryResponse.json());
    const sankeyResponse = await handler(request("/analytics/routes/sankey"));
    const sankey = validateRouteAnalyticsSankeyResponse(await sankeyResponse.json());

    expect(summaryResponse.status).toBe(200);
    expect(sankeyResponse.status).toBe(200);
    expect(summary.rails.map((rail) => rail.rail)).toEqual(
      expect.arrayContaining(["x402", "stripe_mpp", "hitpay_mpp"]),
    );
    expect(summary.rails.find((rail) => rail.rail === "x402")?.visibility).toBe("public_onchain");
    expect(summary.rails.find((rail) => rail.rail === "stripe_mpp")?.visibility).toBe(
      "provider_attested",
    );
    expect(sankey.layers).toEqual(["source_route", "payment_rail", "api_workflow"]);
    expect(sankey.nodes.some((node) => node.label === "Stripe MPP")).toBe(true);
    expect(sankey.nodes.some((node) => node.label === "HitPay MPP")).toBe(true);
    expect(sankey.nodes.some((node) => node.label === "/v1/scrape")).toBe(true);
  });

  // Skipped: mergeProviderCatalogs es un stub no-op desde la migración a
  // Stellar (packages/sources/src/legacy-x402-stub.ts) — el overlay MPP es
  // legacy multi-chain, fuera de scope para el hackathon 100%-Stellar.
  test.skip("merges MPP catalog into providers when overlay path is provided", async () => {
    const tempDir = path.join(process.cwd(), "tmp", `bff-mpp-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const overlayPath = path.join(tempDir, "mpp-catalog.json");
    try {
      const mppCatalog = {
        generatedAt: "2026-05-07T00:00:00.000Z",
        generatedFrom: "mpp-registry-capture",
        providers: [
          {
            providerId:
              "mpp:test-only::tempo:4217::USDC::0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            name: "MPP Test Only",
            serviceId: "test-only",
            serviceName: "MPP Test Only",
            network: "tempo:4217",
            asset: "USDC",
            payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            catalogSource: "mpp_registry",
            transactionCount: 0,
            uniqueSenderCount: 0,
            totalVolumeAtomic: "0",
            endpointCount: 5,
            resourceCount: 1,
            mappingPattern: "one_payto_one_endpoint",
            endpointAttributionStatus: "mpp_attributed_endpoint",
            attributionConfidence: 1,
            hasCustomerFacts: false,
            customerFactCount: 0,
            provenance: "registry_fact",
            provenanceByField: { providerId: "registry_fact" },
            reasons: [{ provenance: "registry_fact", label: "MPP" }],
          },
        ],
        providerCount: 1,
        provenance: "registry_fact",
        provenanceByField: { providers: "registry_fact" },
        reasons: [{ provenance: "registry_fact", label: "MPP overlay test" }],
      };
      fs.writeFileSync(overlayPath, JSON.stringify(mppCatalog));

      const overlaid = applyMppCatalogOverlay(fixtureAnalyticsDataSource, overlayPath);
      const handler = createBffHandler(overlaid);
      const response = await handler(request("/providers"));
      const parsed = validateProviderCatalogResponse(await response.json());

      const mppRow = parsed.providers.find((p) => p.providerId.startsWith("mpp:test-only::"));
      expect(mppRow).toBeDefined();
      expect(mppRow?.catalogSource).toBe("mpp_registry");
      expect(parsed.providerCount).toBe(fixtureAnalyticsDataSource.providers.providerCount + 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("applyMppCatalogOverlay is a no-op when overlay path is undefined", () => {
    const overlaid = applyMppCatalogOverlay(fixtureAnalyticsDataSource, undefined);
    expect(overlaid).toBe(fixtureAnalyticsDataSource);
  });

  test("applyMppCatalogOverlay fails fast when overlay path is set but file is missing", () => {
    expect(() =>
      applyMppCatalogOverlay(
        fixtureAnalyticsDataSource,
        "/tmp/this-file-should-not-exist-bff-mpp-overlay.json",
      ),
    ).toThrow(/BFF_MPP_CATALOG_PATH is set but file does not exist/);
  });

  test("does not auto-load MPP overlay when NODE_ENV=production and BFF_MPP_CATALOG_PATH is unset", () => {
    // Critical regression guard: even if tmp/mpp-provider-catalog.json physically
    // exists at the repo-root location used by DEFAULT_MPP_CATALOG_PATH, production
    // runs must require explicit opt-in via BFF_MPP_CATALOG_PATH.
    const defaultMppPath = path.join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "tmp",
      "mpp-provider-catalog.json",
    );
    let createdForTest = false;
    if (!fs.existsSync(defaultMppPath)) {
      fs.mkdirSync(path.dirname(defaultMppPath), { recursive: true });
      fs.writeFileSync(
        defaultMppPath,
        JSON.stringify({
          generatedAt: "2026-05-07T00:00:00.000Z",
          generatedFrom: "test",
          providers: [],
          providerCount: 0,
          provenance: "registry_fact",
          provenanceByField: { providers: "registry_fact" },
          reasons: [{ provenance: "registry_fact", label: "test" }],
        }),
      );
      createdForTest = true;
    }
    try {
      // Sanity: file must be in place for this regression test to be meaningful.
      expect(fs.existsSync(defaultMppPath)).toBe(true);
      const dataSource = resolveAnalyticsDataSource(undefined, {
        env: { BFF_ANALYTICS_SOURCE: "fixture", NODE_ENV: "production" },
      });
      expect(dataSource).toBe(fixtureAnalyticsDataSource);
    } finally {
      if (createdForTest) fs.rmSync(defaultMppPath, { force: true });
    }
  });

  test("aggregates customers across chains by serviceId", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);
    const sampleProvider = fixtureAnalyticsDataSource.providers.providers.find((p) => p.serviceId);
    if (!sampleProvider?.serviceId) throw new Error("fixture has no serviceId-bearing provider");

    const aggregated = validatePhaseBCustomerListResponse(
      await (
        await handler(
          request(`/customers?serviceId=${encodeURIComponent(sampleProvider.serviceId)}`),
        )
      ).json(),
    );

    expect(aggregated.scope?.serviceId).toBe(sampleProvider.serviceId);
    expect(aggregated.customerCount).toBe(aggregated.customers.length);
  });

  describe("Pay.sh tag derivation", () => {
    const SOLANA = "8MPzJeXx1RipFmRADExptc3UK4EV3nhEFN6NRSx7o7jm";
    const EVM_LOWER = "0xffecfcd0e9888a738a64d9854abfc22ef3a6c717";
    const EVM_UPPER = "0XFFECFCD0E9888A738A64D9854ABFC22EF3A6C717";

    test("isSolanaCustomer recognises chains[].solana regardless of address shape", () => {
      expect(isSolanaCustomer({ address: EVM_LOWER, chains: ["solana", "base"] })).toBe(true);
    });

    test("isSolanaCustomer falls back to base58 detection when chains[] is absent", () => {
      expect(isSolanaCustomer({ address: SOLANA })).toBe(true);
    });

    test("isSolanaCustomer rejects EVM hex addresses (0x and 0X)", () => {
      expect(isSolanaCustomer({ address: EVM_LOWER })).toBe(false);
      expect(isSolanaCustomer({ address: EVM_UPPER })).toBe(false);
    });

    test("isSolanaCustomer rejects ERC20: and SPL: prefixed token identifiers", () => {
      expect(
        isSolanaCustomer({ address: "ERC20:0x036CbD53842c5426634e7929541eC2318f3dCF7e" }),
      ).toBe(false);
      expect(
        isSolanaCustomer({ address: "SPL:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
      ).toBe(false);
    });

    test("shouldTagPaySh is deterministic per address", () => {
      const first = shouldTagPaySh(SOLANA);
      const second = shouldTagPaySh(SOLANA);
      expect(first).toBe(second);
    });

    test("shouldTagPaySh covers ~80% of distinct solana wallets", () => {
      // sample 1000 deterministic base58 wallets to verify the FNV-1a bucket
      // distribution lands close to the documented 80% threshold.
      const charset = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const samples: string[] = [];
      let seed = 0xdeadbeef;
      for (let i = 0; i < 1000; i++) {
        let s = "";
        for (let j = 0; j < 36; j++) {
          seed = Math.imul(seed ^ (seed >>> 15), seed | 1) >>> 0;
          s += charset[seed % charset.length];
        }
        samples.push(s);
      }
      const tagged = samples.filter(shouldTagPaySh).length;
      const ratio = tagged / samples.length;
      expect(ratio).toBeGreaterThanOrEqual(0.75);
      expect(ratio).toBeLessThanOrEqual(0.85);
    });
  });

  test("returns empty list for unknown serviceId", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);
    const empty = validatePhaseBCustomerListResponse(
      await (await handler(request("/customers?serviceId=does-not-exist"))).json(),
    );
    expect(empty.customerCount).toBe(0);
  });

  test("filters customers by payTo without fabricating unknown payTo rows", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);
    const payTo = fixtureAnalyticsDataSource.providers.providers[0]?.payTo;
    if (!payTo) throw new Error("fixture provider missing payTo");

    const scoped = validatePhaseBCustomerListResponse(
      await (await handler(request(`/customers?payTo=${payTo}`))).json(),
    );
    const empty = validatePhaseBCustomerListResponse(
      await (
        await handler(request("/customers?payTo=0x9999999999999999999999999999999999999999"))
      ).json(),
    );

    expect(scoped.scope?.payTo).toBe(payTo.toLowerCase());
    expect(scoped.customerCount).toBeGreaterThan(0);
    expect(empty.customerCount).toBe(0);
  });

  test("returns a validated profile for a known customer wallet", async () => {
    const handler = createBffHandler();

    const response = await handler(
      request(`/customers/${knownCustomerProfileAddress.toUpperCase()}/profile`),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(validatePhaseBCustomerProfileResponse(body).profile.identity.address).toBe(
      knownCustomerProfileAddress,
    );
  });

  test("returns not found for an unknown customer wallet", async () => {
    const handler = createBffHandler();

    const response = await handler(
      request("/customers/0x9999999999999999999999999999999999999999/profile"),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe("not_found");
  });

  test("returns validated customer intelligence for a known customer wallet", async () => {
    const handler = createBffHandler();

    const response = await handler(
      request(`/customers/${knownCustomerIntelligenceAddress.toUpperCase()}/intelligence`),
    );
    const body = await response.json();
    const parsed = validateCustomerIntelligenceResponse(body);

    expect(response.status).toBe(200);
    expect(parsed.customerAddress).toBe(knownCustomerIntelligenceAddress);
    expect(parsed.payToActivities.length).toBeGreaterThan(0);
    expect(parsed.x402Services[0]?.reasons.length).toBeGreaterThan(0);
  });

  test("returns validated upsell metrics for a known customer wallet", async () => {
    const handler = createBffHandler();

    const response = await handler(
      request(`/customers/${knownCustomerIntelligenceAddress.toUpperCase()}/llm/upsell-metrics`),
    );
    const body = await response.json();
    const parsed = validatePhaseBCustomerUpsellMetricsResponse(body);

    expect(response.status).toBe(200);
    expect(parsed.address).toBe(knownCustomerIntelligenceAddress);
    expect(parsed.signals.customerCount).toBeGreaterThan(0);
    expect(parsed.reasonCodes.length).toBeGreaterThan(0);
    expect(parsed.caveats.length).toBeGreaterThan(0);
  });

  test("returns llm_unavailable when llm upsell explanation is not configured", async () => {
    const handler = createBffHandler();

    const response = await handler(
      request(`/customers/${knownCustomerIntelligenceAddress}/llm/upsell-explanation`),
    );
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(503);
    expect(body.error).toBe("llm_unavailable");
    expect(body.message).toContain("LLM");
  });

  test("returns llm_failed with llm service error detail", async () => {
    const llmService: BffLlmService = {
      async generateUpsellExplanation() {
        throw new Error("AccessDeniedException: missing model access");
      },
      async generateWorkflowIntentExplanation() {
        throw new Error("not used in upsell route test");
      },
    };
    const handler = createBffHandler(undefined, llmService);
    const originalConsoleError = console.error;
    console.error = () => { };

    try {
      const response = await handler(
        request(`/customers/${knownCustomerIntelligenceAddress}/llm/upsell-explanation`),
      );
      const body = (await response.json()) as { error: string; message: string };

      expect(response.status).toBe(502);
      expect(body.error).toBe("llm_failed");
      expect(body.message).toContain("AccessDeniedException");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("returns validated llm upsell explanation for a known customer wallet", async () => {
    const llmService: BffLlmService = {
      async generateUpsellExplanation(input) {
        return {
          generatedAt: "2026-05-01T00:00:00Z",
          generatedFrom: "phase-b-llm-upsell-explanation-v1",
          address: input.address,
          sourceGeneratedAt: input.sourceGeneratedAt,
          model: {
            provider: "bedrock",
            modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
            region: "ap-northeast-1",
            promptVersion: "upsell-explanation-v1",
          },
          input: {
            signals: input.signals,
            flags: input.flags,
            reasonCodes: input.reasonCodes,
            caveats: input.caveats,
          },
          explanation: {
            summary:
              "This wallet remains active and shows multi-provider usage, making it a strong upsell candidate.",
            reasons: [
              "Recent activity was observed within the last 7 days.",
              "The wallet interacted with multiple providers and has a high transaction count.",
            ],
            recommendedAction: "Offer a higher-frequency plan or enterprise-style support package.",
            caution:
              "Some supporting metrics are PoC heuristics and should be reviewed before sales commitments.",
          },
          provenance: "derived_insight",
          provenanceByField: {
            address: "onchain_fact",
            model: "derived_insight",
            input: "derived_insight",
            explanation: "derived_insight",
          },
          reasons: [
            { provenance: "derived_insight", label: "llm explanation from upsell metrics" },
          ],
        };
      },
      async generateWorkflowIntentExplanation() {
        throw new Error("not used in upsell route test");
      },
    };
    const handler = createBffHandler(undefined, llmService);

    const response = await handler(
      request(`/customers/${knownCustomerIntelligenceAddress}/llm/upsell-explanation`),
    );
    const body = await response.json();
    const parsed = validatePhaseBCustomerUpsellExplanationResponse(body);

    expect(response.status).toBe(200);
    expect(parsed.address).toBe(knownCustomerIntelligenceAddress);
    expect(parsed.explanation.summary.length).toBeGreaterThan(0);
    expect(parsed.input.reasonCodes.length).toBeGreaterThan(0);
  });
  test("disables Bun idle timeout for llm upsell explanation requests", async () => {
    const llmService: BffLlmService = {
      async generateUpsellExplanation(input) {
        return {
          generatedAt: "2026-05-01T00:00:00Z",
          generatedFrom: "phase-b-llm-upsell-explanation-v1",
          address: input.address,
          sourceGeneratedAt: input.sourceGeneratedAt,
          model: {
            provider: "qvac",
            modelId: "local-upsell-model.gguf",
            promptVersion: "upsell-explanation-v1",
          },
          input: {
            signals: input.signals,
            flags: input.flags,
            reasonCodes: input.reasonCodes,
            caveats: input.caveats,
          },
          explanation: {
            summary: "Local qvac signal",
            reasons: [
              "The wallet appears active based on recent observed transactions.",
              "The wallet used multiple providers in the observed read model.",
            ],
            recommendedAction:
              "Review whether the observed usage pattern matches a higher-support offering.",
            caution: "Some metrics come from PoC heuristics and should be treated cautiously.",
          },
          provenance: "derived_insight",
          provenanceByField: {
            address: "onchain_fact",
            model: "derived_insight",
            input: "derived_insight",
            explanation: "derived_insight",
          },
          reasons: [
            { provenance: "derived_insight", label: "llm explanation from upsell metrics" },
          ],
        };
      },
      async generateWorkflowIntentExplanation() {
        throw new Error("not used in upsell route test");
      },
    };
    const handler = createBffHandler(undefined, llmService);
    const timeoutCalls: Array<{ request: Request; seconds: number }> = [];
    const requestInput = request(
      `/customers/${knownCustomerIntelligenceAddress}/llm/upsell-explanation`,
    );
    const server = {
      timeout(request: Request, seconds: number) {
        timeoutCalls.push({ request, seconds });
      },
    };

    const response = await handler(requestInput, server);

    expect(response.status).toBe(200);
    expect(timeoutCalls).toEqual([{ request: requestInput, seconds: 0 }]);
  });

  test("returns grouped workflow sessions even when workflow-intent llm is unavailable", async () => {
    const handler = createBffHandler(
      {
        ...fixtureAnalyticsDataSource,
        getCustomerProfile(address: string) {
          return address === workflowIntentAddress ? workflowIntentProfile : undefined;
        },
      },
      null,
    );

    const response = await handler(
      request(`/customers/${workflowIntentAddress}/llm/workflow-intent`),
    );
    const parsed = validatePhaseBCustomerWorkflowIntentResponse(await response.json());

    expect(response.status).toBe(200);
    expect(parsed.analysisStatus).toBe("unavailable");
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.explanations).toEqual([]);
    expect(parsed.sessions[0]).toMatchObject({
      eventCount: 3,
      distinctProviderCount: 2,
      totalAmountAtomic: "600",
    });
  });

  test("returns validated workflow intent explanations for a known customer wallet", async () => {
    const llmService: BffLlmService = {
      async generateUpsellExplanation() {
        throw new Error("not used in workflow intent test");
      },
      async generateWorkflowIntentExplanation(request) {
        return {
          model: {
            provider: "bedrock",
            modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
            region: "ap-northeast-1",
            promptVersion: "workflow-intent-v1",
          },
          explanations: request.input.sessions.map((session) => ({
            sessionId: session.sessionId,
            summary: "Automated market check",
            intent:
              "This short burst appears consistent with a bot checking market conditions, evaluating them with an LLM step, and preparing an execution decision.",
            scenarios: [
              "A bot deciding whether to execute a market action.",
              "An automation loop checking whether conditions justify a next step.",
            ],
            evidence: [
              "The calls happened within a single 5 minute window.",
              "Price API and LLM API activity appeared in one ordered burst.",
            ],
            caution:
              "This interpretation is inferred from payment-linked API activity and may not capture the wallet's full offchain logic.",
          })),
        };
      },
    };
    const handler = createBffHandler(
      {
        ...fixtureAnalyticsDataSource,
        getCustomerProfile(address: string) {
          return address === workflowIntentAddress ? workflowIntentProfile : undefined;
        },
      },
      llmService,
    );

    const response = await handler(
      request(`/customers/${workflowIntentAddress}/llm/workflow-intent`),
    );
    const parsed = validatePhaseBCustomerWorkflowIntentResponse(await response.json());

    expect(response.status).toBe(200);
    expect(parsed.analysisStatus).toBe("ready");
    expect(parsed.model?.promptVersion).toBe("workflow-intent-v1");
    expect(parsed.explanations).toEqual([
      expect.objectContaining({
        summary: "Automated market check",
      }),
    ]);
  });

  test("returns not found for unknown customer intelligence", async () => {
    const handler = createBffHandler();

    const response = await handler(
      request("/customers/0x9999999999999999999999999999999999999999/intelligence"),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe("not_found");
  });

  test("returns not found for unknown customer upsell metrics", async () => {
    const handler = createBffHandler();

    const response = await handler(
      request("/customers/0x9999999999999999999999999999999999999999/llm/upsell-metrics"),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe("not_found");
  });

  test("serves wallet usage graph with schema validation", async () => {
    const handler = createBffHandler();

    const response = await handler(request("/wallet-usage-graph"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      validatePhaseBWalletUsageGraphResponse(body).graph.providerWallets.length,
    ).toBeGreaterThan(0);
  });

  test("phase-b projection assigns external x402 provider candidates per payer", () => {
    const fixture = validateRealTransactionFixture(transactionFixture);
    const attribution = validateMockEndpointAttributionFixture(attributionFixture);
    const projections = buildPhaseBProjections(fixture, attribution);
    const graph = validatePhaseBWalletUsageGraphResponse(projections.walletUsageGraph).graph;

    const ownPayTo = graph.providerWallets[0]?.payToWallet;
    expect(ownPayTo).toBeTruthy();

    const allCandidates = graph.providerWallets.flatMap((provider) =>
      provider.payerWallets.flatMap((payer) => payer.otherServiceCandidates),
    );
    const externalCandidates = allCandidates.filter(
      (candidate) => candidate.payToWallet !== ownPayTo,
    );
    const externalProviderIds = new Set(externalCandidates.map((c) => c.providerId));
    const externalProviderNames = new Set(externalCandidates.map((c) => c.providerName));

    expect(externalCandidates.length).toBeGreaterThan(0);
    expect(externalProviderIds.size).toBeGreaterThanOrEqual(3);
    expect(externalProviderNames.has("CoinGecko x402")).toBe(false);
    for (const candidate of externalCandidates) {
      expect(candidate.coUsageCount).toBeGreaterThan(0);
      expect(candidate.confidence).toBeGreaterThan(0);
      expect(candidate.payToWallet).toMatch(/^0x[a-f0-9]{40}$/);
    }
  });

  test("serves coingecko service summary analytics", async () => {
    const handler = createBffHandler();

    const response = await handler(request("/analytics/services/coingecko/summary"));
    const parsed = validateServiceAnalyticsSummaryResponse(await response.json());

    expect(response.status).toBe(200);
    expect(parsed.serviceId).toBe("coingecko");
    expect(parsed.userCount).toBeGreaterThan(100);
    expect(parsed.transactionCount).toBeGreaterThan(0);
    expect(parsed.averageTransactionsPerUser).toBeGreaterThan(0);
    expect(parsed.repeatUserRate).toBeGreaterThanOrEqual(0);
    expect(parsed.topEndpoints.length).toBeGreaterThan(0);
    expect(parsed.comparedToX402.transactionShare).toBeGreaterThan(0);
    expect(parsed.comparedToX402.sampleBasis.length).toBeGreaterThan(0);
    expect(parsed.comparedToX402.availableServiceCount).toBeGreaterThan(1);
    expect(parsed.provenanceByField).toMatchObject({
      transactionCount: "onchain_fact",
      topEndpoints: "derived_insight",
    });
    expect(parsed.topEndpoints[0]?.provenanceByField).toMatchObject({
      transactionCount: expect.stringMatching(/^(derived_insight|onchain_fact)$/),
      userCount: expect.stringMatching(/^(derived_insight|onchain_fact)$/),
    });
    expect(parsed.topEndpoints[0]?.endpointAttributionStatus).toBeTruthy();
    expect(parsed.topEndpoints[0]?.attributionConfidence).toBeGreaterThan(0);
  });

  test("serves generated read models before fixture fallback", async () =>
    withTempFile(async (filePath) => {
      const generatedSummary = {
        ...serviceAnalyticsSummaryResponse,
        generatedFrom: "generated-read-model-test",
        transactionCount: 42,
        topEndpoints: [
          {
            ...serviceAnalyticsSummaryResponse.topEndpoints[0],
            endpointAttributionStatus: "direct_payto_endpoint",
            attributionConfidence: 0.9,
          },
          {
            ...serviceAnalyticsSummaryResponse.topEndpoints[1],
            endpointAttributionStatus: "bundled_payto_unknown_endpoint",
            attributionConfidence: 0.35,
          },
        ],
      };
      const generatedProviders = {
        ...fixtureAnalyticsDataSource.providers,
        generatedFrom: "generated-read-model-test",
        providers: [
          {
            ...fixtureAnalyticsDataSource.providers.providers[0],
            providerId: "generated-provider",
            name: "Generated Provider",
          },
        ],
        providerCount: 1,
      };
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          { serviceSummary: generatedSummary, providers: generatedProviders },
          null,
          2,
        ),
      );
      const handler = createBffHandler(loadGeneratedAnalyticsDataSource(filePath));
      const response = await handler(request("/analytics/services/coingecko/summary"));
      const parsed = validateServiceAnalyticsSummaryResponse(await response.json());
      const providers = validateProviderCatalogResponse(
        await (await handler(request("/providers"))).json(),
      );

      expect(parsed.generatedFrom).toBe("generated-read-model-test");
      expect(providers.providers[0]?.providerId).toBe("generated-provider");
      expect(parsed.transactionCount).toBe(42);
      expect(parsed.topEndpoints.map((endpoint) => endpoint.endpointAttributionStatus)).toEqual([
        "direct_payto_endpoint",
        "bundled_payto_unknown_endpoint",
      ]);
    }));

  test("resolves fixture analytics source when explicitly configured", () => {
    const dataSource = resolveAnalyticsDataSource(undefined, {
      env: { BFF_ANALYTICS_SOURCE: "fixture", BFF_MPP_CATALOG_PATH: "" },
    });

    expect(dataSource).toBe(fixtureAnalyticsDataSource);
  });

  test("treats empty analytics source as unset", () => {
    const dataSource = resolveAnalyticsDataSource("/tmp/flovia-missing-bff-analytics.json", {
      env: { BFF_ANALYTICS_SOURCE: "", BFF_MPP_CATALOG_PATH: "" },
    });

    expect(dataSource).toBe(fixtureAnalyticsDataSource);
  });

  test("resolves generated JSON analytics source when explicitly configured", async () =>
    withTempFile(async (filePath) => {
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            serviceSummary: {
              ...serviceAnalyticsSummaryResponse,
              generatedFrom: "explicit-json-source-test",
              transactionCount: 77,
            },
          },
          null,
          2,
        ),
      );

      const dataSource = await Promise.resolve(
        resolveAnalyticsDataSource(undefined, {
          env: { BFF_ANALYTICS_SOURCE: "json", BFF_ANALYTICS_READ_MODEL_PATH: filePath },
        }),
      );

      expect(dataSource.serviceSummary.generatedFrom).toBe("explicit-json-source-test");
      expect(dataSource.serviceSummary.transactionCount).toBe(77);
    }));

  test("throws when explicit JSON analytics source file is missing", () => {
    expect(() =>
      resolveAnalyticsDataSource("/tmp/flovia-missing-bff-analytics.json", {
        env: { BFF_ANALYTICS_SOURCE: "json" },
      }),
    ).toThrow("BFF analytics JSON read model not found");
  });

  test("service customer filters preserve cross-provider providerCount", async () =>
    withTempFile(async (filePath) => {
      const payer = "0x9999999999999999999999999999999999999001";
      const ownPayTo = "0x9999999999999999999999999999999999999010";
      const otherPayTo = "0x9999999999999999999999999999999999999020";
      const baseCustomer = phaseBCustomerListResponse.customers[0];
      const baseProvider = fixtureAnalyticsDataSource.providers.providers[0];
      const baseGraphProvider =
        fixtureAnalyticsDataSource.walletUsageGraph.graph.providerWallets[0];
      const basePayer = baseGraphProvider?.payerWallets[0];
      const baseObservation = basePayer?.observations[0];

      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            customers: {
              ...phaseBCustomerListResponse,
              customers: [{ ...baseCustomer, address: payer, providerCount: 1 }],
              customerCount: 1,
            },
            providers: {
              ...fixtureAnalyticsDataSource.providers,
              providers: [
                {
                  ...baseProvider,
                  providerId: `own-service--base--usdc--${ownPayTo}`,
                  name: "Own Service",
                  serviceId: "own-service.example",
                  serviceName: "Own Service",
                  payTo: ownPayTo,
                },
                {
                  ...baseProvider,
                  providerId: `other-service--base--usdc--${otherPayTo}`,
                  name: "Other Service",
                  serviceId: "other-service.example",
                  serviceName: "Other Service",
                  payTo: otherPayTo,
                },
              ],
              providerCount: 2,
            },
            walletUsageGraph: {
              ...fixtureAnalyticsDataSource.walletUsageGraph,
              graph: {
                ...fixtureAnalyticsDataSource.walletUsageGraph.graph,
                providerWallets: [
                  {
                    ...baseGraphProvider,
                    providerId: `own-service--base--usdc--${ownPayTo}`,
                    providerName: "Own Service",
                    name: "Own Service",
                    payToWallet: ownPayTo,
                    payerWallets: [
                      {
                        ...basePayer,
                        address: payer,
                        sharedSpendAtomic: "100",
                        sharedTransactionCount: 1,
                        overlapProviderCount: 2,
                        observations: [
                          {
                            ...baseObservation,
                            providerId: `own-service--base--usdc--${ownPayTo}`,
                            providerName: "Own Service",
                            serviceName: "Own Service",
                          },
                        ],
                        otherServiceCandidates: [
                          {
                            providerId: `other-service--base--usdc--${otherPayTo}`,
                            providerName: "Other Service",
                            serviceName: "Other Service",
                            coUsageCount: 1,
                            confidence: 0.5,
                            payToWallet: otherPayTo,
                            provenance: "derived_insight",
                            provenanceByField: { payToWallet: "onchain_fact" },
                            reasons: [{ provenance: "derived_insight", label: "test" }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
      );

      const dataSource = loadGeneratedAnalyticsDataSource(filePath);
      const filtered = dataSource.getCustomersByServiceId("own-service.example");

      expect(filtered.customers).toHaveLength(1);
      expect(filtered.customers[0]?.providerCount).toBe(2);
    }));

  test("throws when postgres analytics source has no database URL", () => {
    expect(() =>
      resolveAnalyticsDataSource(undefined, {
        env: { BFF_ANALYTICS_SOURCE: "postgres" },
      }),
    ).toThrow("BFF analytics postgres source requires");
  });

  test("does not treat a sqlite-style DATABASE_URL as a postgres analytics URL", () => {
    expect(() =>
      resolveAnalyticsDataSource(undefined, {
        env: { BFF_ANALYTICS_SOURCE: "postgres", DATABASE_URL: "/data/flovia.db" },
      }),
    ).toThrow("postgres:// DATABASE_URL");
  });

  test("uses postgres snapshot loader by default", async () => {
    const dataSource = await resolveAnalyticsDataSource(undefined, {
      env: {
        BFF_ANALYTICS_SOURCE: "postgres",
        BFF_ANALYTICS_SNAPSHOT_ID: "snapshot-test",
      },
      postgresClient: {
        async query(sql, params) {
          expect(sql).toBe("SELECT payload FROM bff_analytics_snapshots WHERE id = $1");
          expect(params).toEqual(["snapshot-test"]);
          return [
            {
              payload: {
                serviceSummary: {
                  ...serviceAnalyticsSummaryResponse,
                  generatedFrom: "postgres-snapshot-default-test",
                  transactionCount: 77,
                },
              },
            },
          ];
        },
      },
    });

    expect(dataSource.serviceSummary.generatedFrom).toBe("postgres-snapshot-default-test");
    expect(dataSource.serviceSummary.transactionCount).toBe(77);
  });

  test("uses postgres snapshot loader when mode is empty", async () => {
    const dataSource = await resolveAnalyticsDataSource(undefined, {
      env: {
        BFF_ANALYTICS_SOURCE: "postgres",
        BFF_ANALYTICS_POSTGRES_MODE: "",
        BFF_ANALYTICS_SNAPSHOT_ID: "snapshot-test",
      },
      postgresClient: {
        async query(sql, params) {
          expect(sql).toBe("SELECT payload FROM bff_analytics_snapshots WHERE id = $1");
          expect(params).toEqual(["snapshot-test"]);
          return [
            {
              payload: {
                serviceSummary: {
                  ...serviceAnalyticsSummaryResponse,
                  generatedFrom: "postgres-snapshot-empty-mode-test",
                  transactionCount: 78,
                },
              },
            },
          ];
        },
      },
    });

    expect(dataSource.serviceSummary.generatedFrom).toBe("postgres-snapshot-empty-mode-test");
    expect(dataSource.serviceSummary.transactionCount).toBe(78);
  });

  test("rejects unsupported postgres analytics mode", () => {
    expect(() =>
      resolveAnalyticsDataSource(undefined, {
        env: { BFF_ANALYTICS_SOURCE: "postgres", BFF_ANALYTICS_POSTGRES_MODE: "typo" },
        postgresClient: { query: async () => [] },
      }),
    ).toThrow("Unsupported BFF_ANALYTICS_POSTGRES_MODE: typo");
  });

  test("uses postgres live loader when live mode is configured", async () => {
    const dataSource = await resolveAnalyticsDataSource(undefined, {
      env: { BFF_ANALYTICS_SOURCE: "postgres", BFF_ANALYTICS_POSTGRES_MODE: "live" },
      postgresClient: {
        async query(sql) {
          if (sql.includes("attributed_grouped")) {
            return [
              {
                payer: "0x2222222222222222222222222222222222222222",
                pay_to: "0x1111111111111111111111111111111111111111",
                service_id: "live-service",
                service_name: "Live Service",
                transaction_count: 3,
                total_volume_atomic: "300",
              },
            ];
          }
          if (sql.includes("provider_activity")) {
            return [
              {
                pay_to: "0x1111111111111111111111111111111111111111",
                service_id: "live-service",
                service_name: "Live Service",
                pay_sh_provider_fqn: "live/service",
                transaction_count: 3,
                unique_sender_count: 1,
                total_volume_atomic: "300",
              },
            ];
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    expect(dataSource.serviceSummary.generatedFrom).toBe("postgres-live-read-model");
    expect(dataSource.providers.providers[0]?.serviceId).toBe("live-service");
    expect(dataSource.providers.providers[0]?.catalogSource).toBe("pay_sh_curated");
  });

  test("persists postgres live payload as a named snapshot", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const payload = await persistPostgresLiveAnalyticsSnapshot(
      {
        async query(sql, params) {
          queries.push({ sql, params });
          if (sql.includes("attributed_grouped")) return [];
          if (sql.includes("provider_activity")) return [];
          if (sql.includes("INSERT INTO bff_analytics_snapshots")) return [];
          throw new Error(`unexpected query: ${sql}`);
        },
      },
      "latest",
    );

    const insert = queries.find((query) =>
      query.sql.includes("INSERT INTO bff_analytics_snapshots"),
    );
    expect(insert?.params?.[0]).toBe("latest");
    expect(typeof insert?.params?.[1]).toBe("string");
    expect((payload.serviceSummary as { generatedFrom?: string } | undefined)?.generatedFrom).toBe(
      "postgres-live-read-model",
    );
  });

  test("uses postgres snapshot loader when snapshot mode is configured", async () => {
    const dataSource = await resolveAnalyticsDataSource(undefined, {
      env: {
        BFF_ANALYTICS_SOURCE: "postgres",
        BFF_ANALYTICS_POSTGRES_MODE: "snapshot",
        BFF_ANALYTICS_SNAPSHOT_ID: "snapshot-test",
      },
      postgresClient: {
        async query(sql, params) {
          expect(sql).toBe("SELECT payload FROM bff_analytics_snapshots WHERE id = $1");
          expect(params).toEqual(["snapshot-test"]);
          return [
            {
              payload: {
                serviceSummary: {
                  ...serviceAnalyticsSummaryResponse,
                  generatedFrom: "postgres-snapshot-mode-test",
                  transactionCount: 99,
                },
              },
            },
          ];
        },
      },
    });

    expect(dataSource.serviceSummary.generatedFrom).toBe("postgres-snapshot-mode-test");
    expect(dataSource.serviceSummary.transactionCount).toBe(99);
  });

  test("loads postgres snapshot payload through generated payload validation", async () => {
    const dataSource = await loadPostgresAnalyticsDataSource(
      {
        async query(sql, params) {
          expect(sql).toBe("SELECT payload FROM bff_analytics_snapshots WHERE id = $1");
          expect(params).toEqual(["snapshot-test"]);
          return [
            {
              payload: {
                serviceSummary: {
                  ...serviceAnalyticsSummaryResponse,
                  generatedFrom: "postgres-snapshot-test",
                  transactionCount: 88,
                },
              },
            },
          ];
        },
      },
      "snapshot-test",
    );

    expect(dataSource.serviceSummary.generatedFrom).toBe("postgres-snapshot-test");
    expect(dataSource.serviceSummary.transactionCount).toBe(88);
  });

  test("builds postgres live payload counts from raw rows", async () => {
    const dataSource = await loadPostgresLiveAnalyticsDataSource({
      async query(sql) {
        if (sql.includes("attributed_grouped")) {
          return [
            {
              payer: "0x4444444444444444444444444444444444444444",
              pay_to: "0x3333333333333333333333333333333333333333",
              service_id: "alpha",
              service_name: "Alpha",
              transaction_count: 4,
              total_volume_atomic: "400",
              timeline_events: [
                {
                  at: "2026-05-02T00:00:00.000Z",
                  amountAtomic: "100",
                  transactionId: "0xalpha4",
                },
                {
                  at: "2026-05-01T00:00:00.000Z",
                  amountAtomic: "300",
                  transactionId: "0xalpha1",
                },
              ],
            },
            {
              payer: "0x5555555555555555555555555555555555555555",
              pay_to: "0x3333333333333333333333333333333333333333",
              service_id: "alpha",
              service_name: "Alpha",
              transaction_count: 3,
              total_volume_atomic: "300",
              timeline_events: [
                {
                  at: "2026-05-03T00:00:00.000Z",
                  amountAtomic: "300",
                  transactionId: "0xalpha-other",
                },
              ],
            },
          ];
        }
        if (sql.includes("provider_activity")) {
          return [
            {
              pay_to: "0x3333333333333333333333333333333333333333",
              service_id: "alpha",
              service_name: "Alpha",
              pay_sh_provider_fqn: "alpha/provider",
              title: "Alpha Pay.sh",
              description: "Alpha provider description",
              use_case: "Use Alpha for tests",
              category: "data",
              service_url: "https://alpha.example.com",
              has_metering: true,
              has_free_tier: false,
              provider_sha: "alpha-sha",
              registry_version: "2",
              registry_generated_at: "2026-05-01T00:00:00.000Z",
              registry_source_url: "https://storage.googleapis.com/pay-skills/v1/skills.json",
              endpoint_count: 34,
              offers: [
                {
                  protocol: "x402",
                  chain: "Base",
                  asset: "USDC",
                  payToAddress: "0x3333333333333333333333333333333333333333",
                  probePriceUsd: 0.05,
                },
              ],
              protocol: "x402",
              offer_chain: "Base",
              asset_symbol: "USDC",
              price_range_min_usd: "0.01",
              price_range_max_usd: "0.05",
              resources: [
                {
                  resource: "https://alpha.example.com/resource",
                  description: "Alpha endpoint",
                  method: "GET",
                  inputSchema: { type: "object" },
                  lastUpdated: "2026-05-01T00:00:00.000Z",
                  x402Version: 2,
                  l30DaysTotalCalls: 10,
                  l30DaysUniquePayers: 3,
                },
                {
                  resource: "https://alpha.example.com/no-metadata",
                  inputSchema: null,
                  x402Version: null,
                },
              ],
              transaction_count: 7,
              unique_sender_count: 2,
              total_volume_atomic: "700",
            },
          ];
        }
        return [];
      },
    });

    expect(dataSource.providers.providerCount).toBe(1);
    expect(dataSource.providers.providers[0]).toMatchObject({
      catalogSource: "pay_sh_curated",
      title: "Alpha Pay.sh",
      description: "Alpha provider description",
      useCase: "Use Alpha for tests",
      category: "data",
      serviceUrl: "https://alpha.example.com",
      hasMetering: true,
      hasFreeTier: false,
      providerSha: "alpha-sha",
      registryVersion: "2",
      registryGeneratedAt: "2026-05-01T00:00:00.000Z",
      registrySourceUrl: "https://storage.googleapis.com/pay-skills/v1/skills.json",
      endpointCount: 34,
      offers: [
        {
          protocol: "x402",
          chain: "Base",
          asset: "USDC",
          payToAddress: "0x3333333333333333333333333333333333333333",
          probePriceUsd: 0.05,
        },
      ],
      protocol: "x402",
      chain: "Base",
      assetSymbol: "USDC",
      priceRangeUsd: { min: 0.01, max: 0.05 },
    });
    expect(dataSource.providers.providers[0]?.resources).toMatchObject([
      {
        resource: "https://alpha.example.com/resource",
        description: "Alpha endpoint",
        method: "GET",
        inputSchema: { type: "object" },
        lastUpdated: "2026-05-01T00:00:00.000Z",
        x402Version: 2,
        l30DaysTotalCalls: 10,
        l30DaysUniquePayers: 3,
      },
      { resource: "https://alpha.example.com/no-metadata" },
    ]);
    expect(dataSource.providers.providers[0]?.resources?.[1]?.x402Version).toBeUndefined();
    expect(dataSource.customers.customerCount).toBe(2);
    expect(dataSource.walletUsageGraph.graph.providerWallets[0]?.payerWallets.length).toBe(2);
    expect(dataSource.serviceSummary.userCount).toBe(2);
    expect(dataSource.serviceSummary.transactionCount).toBe(7);
    expect(
      dataSource.getCustomerProfile("0x4444444444444444444444444444444444444444")?.profile.timeline,
    ).toEqual([
      expect.objectContaining({
        at: "2026-05-02T00:00:00.000Z",
        description: "Payment to Alpha",
        amountAtomic: "100",
      }),
      expect.objectContaining({
        at: "2026-05-01T00:00:00.000Z",
        description: "Payment to Alpha",
        amountAtomic: "300",
      }),
    ]);
    expect(
      dataSource.serviceComparison.services.some((service) => service.serviceId === "coingecko"),
    ).toBe(true);
  });

  test("surfaces non-shared Solana facts as Solana provider and customer rows", async () => {
    const basePayTo = "0x3333333333333333333333333333333333333333";
    const solanaPayTo = "8MPzJeXx1RipFmRADExptc3UK4EV3nhEFN6NRSx7o7jm";
    const solanaPayer = "7Payer111111111111111111111111111111111111";
    const offers = [
      {
        protocol: "x402",
        chain: "Base",
        asset: "USDC",
        payToAddress: basePayTo,
      },
      {
        protocol: "x402",
        chain: "Solana",
        asset: "USDC",
        payToAddress: solanaPayTo,
      },
    ];

    const dataSource = await loadPostgresLiveAnalyticsDataSource({
      async query(sql) {
        if (sql.includes("attributed_grouped")) {
          return [
            {
              network: "base",
              asset: "USDC",
              payer: "0x4444444444444444444444444444444444444444",
              pay_to: basePayTo,
              service_id: "dtelecom/voice",
              service_name: "dtelecom/voice",
              transaction_count: 1,
              total_volume_atomic: "100",
            },
            {
              network: "solana mainnet",
              asset: "USDC",
              payer: solanaPayer,
              pay_to: solanaPayTo,
              service_id: "dtelecom/voice",
              service_name: "dtelecom/voice",
              transaction_count: 12,
              total_volume_atomic: "1046800001",
            },
          ];
        }
        if (sql.includes("provider_activity")) {
          return [
            {
              network: "base",
              asset: "USDC",
              pay_to: basePayTo,
              service_id: "dtelecom/voice",
              service_name: "dtelecom/voice",
              pay_sh_provider_fqn: "dtelecom/voice",
              offers,
              transaction_count: 1,
              unique_sender_count: 1,
              total_volume_atomic: "100",
            },
            {
              network: "solana mainnet",
              asset: "USDC",
              pay_to: solanaPayTo,
              service_id: "dtelecom/voice",
              service_name: "dtelecom/voice",
              pay_sh_provider_fqn: "dtelecom/voice",
              offers,
              transaction_count: 12,
              unique_sender_count: 1,
              total_volume_atomic: "1046800001",
            },
          ];
        }
        return [];
      },
    });

    expect(dataSource.providers.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          network: "solana mainnet",
          asset: "USDC",
          serviceId: "dtelecom/voice",
          transactionCount: 12,
        }),
      ]),
    );
    const solanaProviderWallet = dataSource.walletUsageGraph.graph.providerWallets.find(
      (provider) => provider.payToWallet === solanaPayTo,
    );
    expect(solanaProviderWallet).toEqual(
      expect.objectContaining({
        providerId: expect.stringContaining("dtelecom-voice--solana-mainnet--usdc"),
        payerWallets: expect.arrayContaining([
          expect.objectContaining({ address: solanaPayer, sharedTransactionCount: 12 }),
        ]),
      }),
    );

    const customers = dataSource.getCustomersByServiceId("dtelecom/voice");
    expect(customers.customers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: solanaPayer,
          chains: expect.arrayContaining(["solana mainnet"]),
          spendByAsset: expect.objectContaining({ USDC: "1046800001" }),
        }),
      ]),
    );
  });

  test("normalizes Solana chain and token asset before joining catalog offers to live facts", async () => {
    let providerSql = "";
    let customerSql = "";

    await loadPostgresLiveAnalyticsDataSource({
      async query(sql) {
        if (sql.includes("attributed_grouped")) {
          customerSql = sql;
          return [];
        }
        providerSql = sql;
        return [];
      },
    });

    expect(providerSql).toContain("WHEN lower(s.chain) = 'solana' THEN 'solana mainnet'");
    expect(providerSql).toContain("WHEN lower(s.asset) = 'usdc' THEN 'USDC'");
    expect(providerSql).toContain("WHEN lower(s.asset) = 'usdt' THEN 'USDT'");
    expect(providerSql).toContain(
      "WHEN lower(chain) = 'solana' AND lower(protocol) = 'mpp' THEN 'solana mainnet (mpp)'",
    );
    expect(providerSql).toContain("AND (pg.network = 'base' OR pg.service_id = ppt.provider_fqn)");
    expect(customerSql).toContain("WHEN lower(s.chain) = 'solana' THEN 'solana mainnet'");
    expect(customerSql).toContain("WHEN lower(s.asset) = 'usdc' THEN 'USDC'");
    expect(customerSql).toContain("WHEN lower(s.asset) = 'usdt' THEN 'USDT'");
    expect(customerSql).toContain("CROSS JOIN LATERAL unnest(s.provider_fqns)");
  });

  test("keeps Solana live facts to offer-priced or small variable-price transfers", async () => {
    let providerSql = "";
    let customerSql = "";

    await loadPostgresLiveAnalyticsDataSource({
      async query(sql) {
        if (sql.includes("attributed_grouped")) {
          customerSql = sql;
          return [];
        }
        providerSql = sql;
        return [];
      },
    });

    for (const sql of [providerSql, customerSql]) {
      expect(sql).toContain("pay_sh_solana_offer_prices AS");
      expect(sql).toContain("ROUND((o.probe_price_usd::numeric * 1000000))::numeric");
      expect(sql).toContain("JOIN pay_sh_solana_offer_prices offer_price");
      expect(sql).toContain("provider.provider_fqn = offer_price.provider_fqn");
      expect(sql).toContain("s.amount::numeric = offer_price.amount_atomic");
      expect(sql).toContain("s.amount::numeric <= 10000000");
    }
  });

  test("includes Tempo MPP token transfers in live facts", async () => {
    let providerSql = "";
    let customerSql = "";

    await loadPostgresLiveAnalyticsDataSource({
      async query(sql) {
        if (sql.includes("attributed_grouped")) {
          customerSql = sql;
          return [];
        }
        providerSql = sql;
        return [];
      },
    });

    for (const sql of [providerSql, customerSql]) {
      expect(sql).toContain("tempo_offer_prices AS");
      expect(sql).toContain("FROM token_transfers t");
      expect(sql).toContain("t.chain = 'tempo'");
      expect(sql).toContain("0x20c000000000000000000000b9537d11c60e8b50");
      expect(sql).toContain("t.amount_atomic::numeric <= 10000000");
    }
  });

  test("filters Base live facts to known x402 payment option amounts", async () => {
    let providerSql = "";
    let customerSql = "";

    await loadPostgresLiveAnalyticsDataSource({
      async query(sql) {
        if (sql.includes("attributed_grouped")) {
          customerSql = sql;
          return [];
        }
        providerSql = sql;
        return [];
      },
    });

    for (const sql of [providerSql, customerSql]) {
      expect(sql).toContain("base_x402_payment_amounts AS");
      expect(sql).toContain("FROM x402_payment_options po");
      expect(sql).toContain("option_amount.pay_to = lower(g.to_owner_address)");
      expect(sql).toContain("AND g.amount::numeric = option_amount.amount_atomic");
    }
  });

  test("queries pay.sh catalog providers independently from live activity", async () => {
    let providerSql = "";

    await loadPostgresLiveAnalyticsDataSource({
      async query(sql) {
        if (sql.includes("attributed_grouped")) return [];
        providerSql = sql;
        return [];
      },
    });

    expect(providerSql).toContain("pay_sh_provider_catalog AS");
    expect(providerSql).toContain("FROM pay_sh_providers p");
    expect(providerSql).toContain("provider_pay_tos AS");
    expect(providerSql).toContain("SELECT DISTINCT");
    expect(providerSql).toContain("provider_metrics AS");
    expect(providerSql).toContain("LEFT JOIN provider_grouped pg");
    expect(providerSql).toContain("UNION ALL");
    expect(providerSql).toContain("WHERE lower(pg.service_id) IN");
    expect(providerSql).not.toContain("OR pay_sh.provider_fqn IS NOT NULL");
  });

  test("includes pay.sh catalog providers without live tx and excludes raw live-only providers", async () => {
    const payShWithLivePayTo = "0x1111111111111111111111111111111111111111";
    const payShWithoutLivePayTo = "0x2222222222222222222222222222222222222222";
    const rawLiveOnlyPayTo = "0x3333333333333333333333333333333333333333";
    const basePayTo = "0x4444444444444444444444444444444444444444";

    const dataSource = await loadPostgresLiveAnalyticsDataSource({
      async query(sql) {
        if (sql.includes("attributed_grouped")) return [];
        return [
          {
            pay_to: payShWithLivePayTo,
            service_id: "pay-sh/live-provider",
            service_name: "Pay.sh Live Provider",
            pay_sh_provider_fqn: "pay-sh/live-provider",
            offers: [
              {
                protocol: "x402",
                chain: "Base",
                asset: "USDC",
                payToAddress: payShWithLivePayTo,
              },
            ],
            transaction_count: 5,
            unique_sender_count: 2,
            total_volume_atomic: "500",
          },
          {
            pay_to: payShWithoutLivePayTo,
            service_id: "pay-sh/no-live-provider",
            service_name: "Pay.sh No Live Provider",
            pay_sh_provider_fqn: "pay-sh/no-live-provider",
            offers: [
              {
                protocol: "x402",
                chain: "Base",
                asset: "USDC",
                payToAddress: payShWithoutLivePayTo,
              },
            ],
            transaction_count: 0,
            unique_sender_count: 0,
            total_volume_atomic: "0",
          },
          {
            pay_to: rawLiveOnlyPayTo,
            service_id: "raw-live-only.example",
            service_name: "Raw Live Only",
            transaction_count: 99,
            unique_sender_count: 10,
            total_volume_atomic: "9900",
          },
          {
            pay_to: basePayTo,
            service_id: "api.nansen.ai",
            service_name: "api.nansen.ai",
            transaction_count: 3,
            unique_sender_count: 1,
            total_volume_atomic: "300",
          },
        ];
      },
    });

    expect(dataSource.providers.providers.map((provider) => provider.serviceId)).toEqual([
      "pay-sh/live-provider",
      "pay-sh/no-live-provider",
      "api.nansen.ai",
    ]);
    expect(dataSource.providers.providerCount).toBe(3);
    expect(dataSource.providers.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceId: "pay-sh/live-provider",
          catalogSource: "pay_sh_curated",
          transactionCount: 5,
          uniqueSenderCount: 2,
          totalVolumeAtomic: "500",
          hasCustomerFacts: true,
        }),
        expect.objectContaining({
          serviceId: "pay-sh/no-live-provider",
          catalogSource: "pay_sh_curated",
          transactionCount: 0,
          uniqueSenderCount: 0,
          totalVolumeAtomic: "0",
          hasCustomerFacts: false,
        }),
        expect.objectContaining({
          serviceId: "api.nansen.ai",
          catalogSource: "base_curated",
        }),
      ]),
    );
    expect(
      dataSource.providers.providers.some(
        (provider) => provider.serviceId === "raw-live-only.example",
      ),
    ).toBe(false);
  });

  test("keeps non-wallet pay.sh recipients out of wallet usage graph", async () => {
    const dataSource = await loadPostgresLiveAnalyticsDataSource({
      async query(sql) {
        if (sql.includes("attributed_grouped")) return [];
        return [
          {
            pay_to: "https://api.invalid.example/x402",
            service_id: "pay-sh/http-recipient",
            service_name: "Pay.sh HTTP Recipient",
            pay_sh_provider_fqn: "pay-sh/http-recipient",
            offers: [
              {
                protocol: "x402",
                chain: "Base",
                asset: "USDC",
                payToAddress: "https://api.invalid.example/x402",
              },
            ],
            transaction_count: 0,
            unique_sender_count: 0,
            total_volume_atomic: "0",
          },
        ];
      },
    });

    expect(dataSource.providers.providers).toEqual([
      expect.objectContaining({
        serviceId: "pay-sh/http-recipient",
        catalogSource: "pay_sh_curated",
        payTo: "https://api.invalid.example/x402",
      }),
    ]);
    expect(dataSource.walletUsageGraph.graph.providerWallets).toEqual([]);
  });

  test("reflects generic x402 overlap in CoinGecko customer providerCount", async () => {
    const coingeckoPayTo = "0x6666666666666666666666666666666666666666";
    const genericPayTo = "0x7777777777777777777777777777777777777777";
    const payer = "0x8888888888888888888888888888888888888888";
    const dataSource = await loadPostgresLiveAnalyticsDataSource({
      async query(sql) {
        if (sql.includes("attributed_grouped")) {
          return [
            {
              payer,
              pay_to: genericPayTo,
              service_id: "generic-service",
              service_name: "Generic Service",
              transaction_count: 2,
              total_volume_atomic: "200",
            },
            {
              payer,
              pay_to: coingeckoPayTo,
              service_id: "pro-api.coingecko.com",
              service_name: "pro-api.coingecko.com",
              transaction_count: 1,
              total_volume_atomic: "100",
            },
          ];
        }
        if (sql.includes("provider_activity")) {
          return [
            {
              pay_to: genericPayTo,
              service_id: "generic-service",
              service_name: "Generic Service",
              transaction_count: 2,
              unique_sender_count: 1,
              total_volume_atomic: "200",
            },
            {
              pay_to: coingeckoPayTo,
              service_id: "pro-api.coingecko.com",
              service_name: "pro-api.coingecko.com",
              transaction_count: 1,
              unique_sender_count: 1,
              total_volume_atomic: "100",
            },
          ];
        }
        return [];
      },
    });

    expect(
      dataSource.customers.customers.find((customer) => customer.address === payer)?.providerCount,
    ).toBe(2);
    const coingeckoProvider = dataSource.walletUsageGraph.graph.providerWallets.find(
      (provider) => provider.payToWallet === coingeckoPayTo,
    );
    const payerWallet = coingeckoProvider?.payerWallets.find((wallet) => wallet.address === payer);

    expect(dataSource.providers.providers.map((provider) => provider.serviceId)).toEqual([
      "pro-api.coingecko.com",
    ]);
    expect(dataSource.providers.providers[0]?.catalogSource).toBe("base_curated");
    expect(payerWallet?.overlapProviderCount).toBe(2);
    expect(payerWallet?.otherServiceCandidates).toEqual([
      expect.objectContaining({
        providerName: "Generic Service",
        serviceName: "Generic Service",
        coUsageCount: 2,
        payToWallet: genericPayTo,
      }),
    ]);
  });

  test("does not mix generated customer lookups with demo fixture profiles", async () =>
    withTempFile(async (filePath) => {
      fs.writeFileSync(
        filePath,
        JSON.stringify({ serviceSummary: serviceAnalyticsSummaryResponse }, null, 2),
      );
      const handler = createBffHandler(loadGeneratedAnalyticsDataSource(filePath));

      const profileResponse = await handler(
        request(`/customers/${knownCustomerProfileAddress}/profile`),
      );
      const intelligenceResponse = await handler(
        request(`/customers/${knownCustomerIntelligenceAddress}/intelligence`),
      );
      const upsellMetricsResponse = await handler(
        request(`/customers/${knownCustomerProfileAddress}/llm/upsell-metrics`),
      );

      expect(profileResponse.status).toBe(404);
      expect(intelligenceResponse.status).toBe(404);
      expect(upsellMetricsResponse.status).toBe(404);
    }));

  test("serves x402 service comparison analytics", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);

    const response = await handler(request("/analytics/services/comparison"));
    const parsed = validateServiceAnalyticsComparisonResponse(await response.json());

    expect(response.status).toBe(200);
    expect(parsed.services[0]).toMatchObject({
      serviceId: "coingecko",
      userCount: expect.any(Number),
      transactionCount: expect.any(Number),
    });
    expect(parsed.services.length).toBeGreaterThan(1);
    expect(new Set(parsed.services.map((service) => service.serviceId)).size).toBe(
      parsed.services.length,
    );
    expect(parsed.services.some((service) => service.serviceId !== "coingecko")).toBe(true);
    expect(parsed.services.every((service) => service.sampleBasis.length > 0)).toBe(true);
    expect(parsed.services.every((service) => service.reasons?.length)).toBe(true);
  });

  test("serves quadrant-ready service analytics without chain tabs", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);

    const response = await handler(request("/analytics/services/quadrants"));
    const body = await response.json();
    const parsed = validateServiceAnalyticsQuadrantResponse(body);

    expect(response.status).toBe(200);
    expect(parsed.axes).toEqual({
      x: { key: "averageTransactionsPerUser", label: "Average transactions per user" },
      y: { key: "endpointDiversity", label: "Endpoint diversity" },
    });
    expect(parsed.points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serviceId: "coingecko", isCoinGecko: true }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain('"solana"');
    expect(JSON.stringify(body)).not.toContain('"base"');
  });

  test("does not expose demo and telemetry endpoints", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);

    for (const path of ["/demo-data", "/sdk-events", "/telemetry", "/mock-attribution"] as const) {
      const response = await handler(request(path));
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(404);
      expect(body.error).toBe("not_found");
      expect(response.headers.get("content-type")).toContain("application/json");
    }
  });

  test("keeps product endpoints read-only", async () => {
    const handler = createBffHandler();

    const paths = [
      "/customers",
      "/providers",
      `/customers/${knownCustomerProfileAddress}/profile`,
      `/customers/${knownCustomerIntelligenceAddress}/intelligence`,
      `/customers/${knownCustomerIntelligenceAddress}/llm/upsell-metrics`,
      `/customers/${knownCustomerIntelligenceAddress}/llm/upsell-explanation`,
      `/customers/${workflowIntentAddress}/llm/workflow-intent`,
      "/wallet-usage-graph",
      "/analytics/services/coingecko/summary",
      "/analytics/services/comparison",
      "/analytics/services/quadrants",
    ] as const;

    for (const path of paths) {
      const response = await handler(request(path, { method: "POST" }));
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
      expect(body.error).toBe("method_not_allowed");
    }
  });

  test("returns not found for unsupported analytics routes", async () => {
    const handler = createBffHandler();
    const response = await handler(request("/analytics/services/unknown"));
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("/analytics/services/unknown");
  });

  test("validates real transaction and mock attribution fixtures", () => {
    const transactions = validateRealTransactionFixture(transactionFixture);
    const attribution = validateMockEndpointAttributionFixture(attributionFixture);

    expect(transactions.metadata.requestedLimit).toBe(5000);
    expect(new Date(transactions.metadata.timeWindow.from ?? "").toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(transactions.metadata.capturedCount).toBeGreaterThan(1000);
    expect(transactions.metadata.capturedCount).toBe(transactions.facts.length);
    expect(attribution.items).toHaveLength(transactions.facts.length);
    expect(new Set(transactions.facts.map((fact) => fact.txHash)).size).toBe(
      transactions.facts.length,
    );
    expect(new Set(attribution.items.map((item) => item.txHash)).size).toBe(
      attribution.items.length,
    );
    expect(transactions.facts[0]).toMatchObject({
      txHash: "0x6248880ec36541e6783ab756afdb427939f6209551b751cec5a2c97f71176d94",
      payerWallet: "0xac5a07c44a4f971667b3df4b6551fb6991b2142d",
      payTo: "0x110cdbba7fe6434ec4ce3464cc523942ad6fb784",
      amount: "10000",
      asset: "USDC",
      network: "base",
      provenance: "onchain_fact",
    });
    expect(attribution.items.map((item) => item.endpointPath)).toEqual(
      expect.arrayContaining([
        "/api/v3/x402/onchain/simple/networks/base/token_price/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "/api/v3/x402/onchain/search/pools",
        "/api/v3/x402/onchain/networks/base/trending_pools",
        "/api/v3/x402/onchain/networks/base/tokens/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "/api/v3/x402/simple/price",
      ]),
    );
  });

  test("rejects mock attribution whose txHash is absent from transaction facts", () => {
    expect(() =>
      joinTransactionAttribution(transactionFixture, {
        ...attributionFixture,
        items: [
          ...attributionFixture.items,
          {
            ...attributionFixture.items[0],
            txHash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          },
        ],
      }),
    ).toThrow("unknown txHash");
  });

  test("rejects mock attribution that is missing a transaction fact", () => {
    expect(() =>
      joinTransactionAttribution(transactionFixture, {
        ...attributionFixture,
        items: attributionFixture.items.slice(1),
      }),
    ).toThrow("count mismatch");
  });

  test("rejects duplicate mock attribution txHash entries", () => {
    expect(() =>
      joinTransactionAttribution(transactionFixture, {
        ...attributionFixture,
        items: [...attributionFixture.items, attributionFixture.items[0]],
      }),
    ).toThrow("attribution txHash values must be unique");
  });

  test("keeps onchain facts and demo attribution provenance separated", () => {
    const [record] = joinedPhaseBProjectionRecords;

    expect(record?.provenanceByField).toMatchObject({
      txHash: "onchain_fact",
      payerWallet: "onchain_fact",
      payTo: "onchain_fact",
      endpointPath: "demo_label",
      workflowLabel: "future_sdk_field",
    });
    expect(phaseBCustomerListResponse.customers.every((customer) => customer.reasons?.length)).toBe(
      true,
    );
    expect(record?.reasons.length).toBeGreaterThan(0);
  });

  test("customer intelligence uses prepared fixture provenance without live source calls", async () => {
    const handler = createBffHandler(fixtureAnalyticsDataSource);
    const response = await handler(
      request(`/customers/${knownCustomerIntelligenceAddress}/intelligence`),
    );
    const parsed = validateCustomerIntelligenceResponse(await response.json());

    expect(parsed.sourceCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "bitquery", status: "available" }),
        expect.objectContaining({ source: "cdp_discovery", status: "available" }),
        expect.objectContaining({
          source: "portfolio",
          status: expect.stringMatching(/^(available|partial)$/),
          provenance: expect.objectContaining({ sourceKind: "zerion" }),
        }),
      ]),
    );
    expect(parsed.provenanceByField).toMatchObject({
      payToActivities: "onchain_fact",
      x402Services: "derived_insight",
    });
  });

  test("builds projections that validate against Phase B schemas", () => {
    const projections = buildPhaseBProjections(transactionFixture, attributionFixture);

    expect(
      validatePhaseBCustomerListResponse(projections.customerList).customerCount,
    ).toBeGreaterThan(100);
    for (const profile of Object.values(projections.profilesByAddress)) {
      expect(
        validatePhaseBCustomerProfileResponse(profile).profile.metrics.reasons?.length,
      ).toBeGreaterThan(0);
    }
    expect(
      validatePhaseBWalletUsageGraphResponse(projections.walletUsageGraph).graph.reasons.length,
    ).toBeGreaterThan(0);
    expect(
      validatePhaseBWalletUsageGraphResponse(projections.walletUsageGraph).graph.providerWallets[0]
        ?.payerWallets.length,
    ).toBeLessThanOrEqual(100);
    expect(
      Object.values(projections.profilesByAddress).every(
        (profile) => profile.profile.timeline.length <= 20 && profile.profile.providers.length <= 5,
      ),
    ).toBe(true);
  });
});
