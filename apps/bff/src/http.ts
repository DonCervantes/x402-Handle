import { timingSafeEqual } from "node:crypto";
import { normalizePaymentRecipientAddress } from "contracts";
import {
  type BffAnalyticsDataSource,
  fixtureAnalyticsDataSource,
  resolveAnalyticsDataSource,
} from "./data/analytics-source";
import { BffLlmUnavailableError, type BffLlmService, resolveBffLlmService } from "./data/llm";
import { type ProviderListView, deriveProviderListView } from "./data/provider-list-view";
import { buildWorkflowIntentInputFromProfile, toWorkflowIntentInput } from "./data/workflow-intent";
import { type X402DiscoveryStore, createX402DiscoveryStore } from "./data/x402-discovery/store";
import {
  json,
  analyticsLoading,
  analyticsUnavailable,
  badRequest,
  cachedJson,
  forbidden,
  llmFailed,
  llmUnavailable,
  methodNotAllowed,
  notFound,
  unauthorized,
  workflowIntentFailed,
  workflowIntentNoCandidateSessions,
  workflowIntentReady,
  workflowIntentUnavailable,
} from "./http/responses";
import {
  AEO_X402_REFRESH_PATH,
  STELLAR_PLAYGROUND_PAY_PATH,
  matchCustomerRoute,
  matchProviderDetailRoute,
  matchStellarProviderRoute,
  normalizePath,
  readonlyRoutes,
} from "./http/routes";
import { handleShowcaseRoute, showcaseRoutes } from "./showcase";
import { getStellarHealth } from "./data/stellar-health";
import { runPlaygroundPayment } from "./data/stellar-playground";
import {
  getProviderIntelligence,
  getStatsOverview,
  getStellarProviderById,
  listStellarProviders,
  recommendStellarProviders,
} from "./data/stellar-providers";
import {
  type CorsOptions,
  createCorsOptions,
  handleCorsPreFlight,
  wrapResponseWithCors,
} from "./middleware/cors";
import {
  RateLimiter,
  resolveRateLimitConfigs,
  getRateLimitCategory,
} from "./middleware/rate-limit";

type RequestTimeoutController = {
  timeout(request: Request, seconds: number): void;
};
type RuntimeEnv = NodeJS.ProcessEnv;
export type BffRuntimeMetadata = {
  commitHash: string | null;
  startedAt: string;
};

const isPromiseLike = <T>(value: T | Promise<T>): value is Promise<T> =>
  typeof (value as Promise<T>).then === "function";

type AnalyticsLoadState =
  | {
      status: "loading";
      promise: Promise<BffAnalyticsDataSource>;
      dataSource?: undefined;
      error?: undefined;
    }
  | {
      status: "ready" | "fallback";
      promise: Promise<BffAnalyticsDataSource>;
      dataSource: BffAnalyticsDataSource & ProviderListView;
      error?: string;
    }
  | {
      status: "failed";
      promise: Promise<BffAnalyticsDataSource>;
      dataSource?: undefined;
      error: string;
    };

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;

const normalizeCommitHash = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed || !COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
};

const resolveCommitHash = (env: RuntimeEnv) =>
  normalizeCommitHash(env.BFF_COMMIT_HASH) ??
  normalizeCommitHash(env.DEPLOY_GIT_SHA) ??
  normalizeCommitHash(env.GITHUB_SHA) ??
  normalizeCommitHash(env.BFF_DEPLOY_ID) ??
  "unknown";

const bytesToMib = (bytes: number) => Math.round(bytes / 1024 / 1024);

const memoryUsageMib = () => {
  const memory = process.memoryUsage();
  return {
    rss: bytesToMib(memory.rss),
    heapTotal: bytesToMib(memory.heapTotal),
    heapUsed: bytesToMib(memory.heapUsed),
    external: bytesToMib(memory.external),
    arrayBuffers: bytesToMib(memory.arrayBuffers),
  };
};

export const resolveBffRuntimeMetadata = (
  env: RuntimeEnv = process.env,
  now: Date = new Date(),
): BffRuntimeMetadata => ({
  commitHash: resolveCommitHash(env),
  startedAt: now.toISOString(),
});

export const createBffHandler = (
  dataSource: BffAnalyticsDataSource | Promise<BffAnalyticsDataSource> | undefined = undefined,
  llmService: BffLlmService | null = resolveBffLlmService(),
  runtimeMetadata: BffRuntimeMetadata = resolveBffRuntimeMetadata(),
  x402Store: X402DiscoveryStore = createX402DiscoveryStore(),
  corsOptions: CorsOptions = createCorsOptions(),
  rateLimiter: RateLimiter = new RateLimiter(resolveRateLimitConfigs()),
) => {
  let analyticsState: AnalyticsLoadState;

  // Attach request-cheap derived views (lightweight provider list + by-id lookup)
  // once, at the moment a data source becomes ready, so request handlers never
  // pay to strip/index the catalog per request.
  const withProviderViews = (
    source: BffAnalyticsDataSource,
  ): BffAnalyticsDataSource & ProviderListView => ({
    ...source,
    ...deriveProviderListView(source.providers),
  });

  const setFallbackState = (promise: Promise<BffAnalyticsDataSource>, error: unknown) => {
    const message = error instanceof Error ? error.message : "Analytics preload failed.";
    console.error("Analytics preload failed; falling back to fixture analytics.", error);
    analyticsState = {
      status: "fallback",
      promise,
      dataSource: withProviderViews(fixtureAnalyticsDataSource),
      error: message,
    };
    return fixtureAnalyticsDataSource;
  };

  const preloadAnalytics = (): Promise<BffAnalyticsDataSource> => {
    try {
      const resolved = dataSource ?? resolveAnalyticsDataSource();
      if (!isPromiseLike(resolved)) {
        const promise = Promise.resolve(resolved);
        analyticsState = {
          status: "ready",
          promise,
          dataSource: withProviderViews(resolved),
        };
        return promise;
      }

      const sourcePromise = resolved;
      const promise = sourcePromise.then(
        (loaded) => {
          analyticsState = {
            status: "ready",
            promise: sourcePromise,
            dataSource: withProviderViews(loaded),
          };
          return loaded;
        },
        (error) => setFallbackState(Promise.resolve(fixtureAnalyticsDataSource), error),
      );
      analyticsState = {
        status: "loading",
        promise,
      };
      return promise;
    } catch (error) {
      const promise = Promise.resolve(fixtureAnalyticsDataSource);
      setFallbackState(promise, error);
      return promise;
    }
  };

  void preloadAnalytics();

  const getReadyDataSource = () => {
    if (analyticsState.status === "ready" || analyticsState.status === "fallback") {
      return analyticsState.dataSource;
    }
    return null;
  };

  const analyticsStatusBody = () => {
    const body: Record<string, string | null> = {
      analyticsStatus: analyticsState.status,
    };
    return body;
  };

  const extractRefreshToken = (request: Request): string | null => {
    const auth = request.headers.get("authorization");
    if (auth?.toLowerCase().startsWith("bearer ")) {
      const token = auth.slice(7).trim();
      if (token) return token;
    }
    const headerToken = request.headers.get("x-refresh-token")?.trim();
    return headerToken && headerToken.length > 0 ? headerToken : null;
  };

  const tokensMatch = (provided: string, expected: string): boolean => {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };

  const handleAeoRefresh = async (
    request: Request,
    server?: RequestTimeoutController,
  ): Promise<Response> => {
    const expected = process.env.BFF_X402_REFRESH_TOKEN?.trim();
    if (!expected) {
      return forbidden(
        "x402 discovery refresh is disabled (set BFF_X402_REFRESH_TOKEN to enable).",
      );
    }
    const provided = extractRefreshToken(request);
    if (!provided || !tokensMatch(provided, expected)) {
      return unauthorized("Invalid x402 discovery refresh token.");
    }
    try {
      // A full live refresh paginates thousands of resources; disable the idle timeout.
      server?.timeout(request, 0);
      const status = await x402Store.refresh();
      return json({ status: "ok", ...status });
    } catch (error) {
      return json(
        {
          error: "x402_refresh_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 502 },
      );
    }
  };

  return async (request: Request, server?: RequestTimeoutController) => {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return handleCorsPreFlight(request, corsOptions);
    }

    const url = new URL(request.url);
    const path = normalizePath(url);

    // Apply rate limiting to sensitive endpoints
    const rateLimitCategory = getRateLimitCategory(path);
    if (rateLimitCategory) {
      const rateLimitResponse = rateLimiter.checkRateLimit(request, rateLimitCategory);
      if (rateLimitResponse) {
        return wrapResponseWithCors(request, rateLimitResponse, corsOptions);
      }
    }

    const customerRoute = matchCustomerRoute(path);
    const providerRoute = matchProviderDetailRoute(path);
    const stellarProviderRoute = matchStellarProviderRoute(path);

    // ─── Día 4 — registry Stellar (independiente del data layer legacy) ───
    if (request.method === "GET" && path === "/stellar/health") {
      return wrapResponseWithCors(request, json(await getStellarHealth()), corsOptions);
    }
    if (request.method === "GET" && path === "/stellar/providers") {
      return wrapResponseWithCors(request, cachedJson(await listStellarProviders()), corsOptions);
    }
    if (request.method === "GET" && stellarProviderRoute) {
      if (stellarProviderRoute.kind === "detail") {
        const provider = await getStellarProviderById(stellarProviderRoute.id);
        return wrapResponseWithCors(
          request,
          provider ? cachedJson(provider) : notFound(path),
          corsOptions,
        );
      }
      const intelligence = await getProviderIntelligence(stellarProviderRoute.id);
      return wrapResponseWithCors(
        request,
        intelligence ? cachedJson(intelligence) : notFound(path),
        corsOptions,
      );
    }
    if (request.method === "GET" && path === "/stellar/recommend") {
      const category = url.searchParams.get("category") ?? undefined;
      const maxPriceUsdcRaw = url.searchParams.get("maxPriceUsdc");
      const maxPriceUsdc = maxPriceUsdcRaw ? Number(maxPriceUsdcRaw) : undefined;
      return wrapResponseWithCors(
        request,
        json(await recommendStellarProviders({ category, maxPriceUsdc })),
        corsOptions,
      );
    }
    if (request.method === "GET" && path === "/stats/overview") {
      return wrapResponseWithCors(request, cachedJson(await getStatsOverview()), corsOptions);
    }
    if (request.method === "POST" && path === STELLAR_PLAYGROUND_PAY_PATH) {
      const body = await request.json().catch(() => null);
      const providerId = typeof body?.providerId === "string" ? body.providerId : null;
      if (!providerId) {
        return wrapResponseWithCors(
          request,
          badRequest("Body debe incluir { providerId: string }."),
          corsOptions,
        );
      }
      // El pago real toma varios segundos (submit + confirmación en Horizon).
      server?.timeout(request, 0);
      const result = await runPlaygroundPayment(providerId);
      return wrapResponseWithCors(
        request,
        json(result, { status: result.ok ? 200 : 422 }),
        corsOptions,
      );
    }

    if (request.method !== "GET") {
      if (request.method === "POST" && path === AEO_X402_REFRESH_PATH) {
        return wrapResponseWithCors(request, await handleAeoRefresh(request, server), corsOptions);
      }

      if (
        request.method === "POST" &&
        (path === "/showcase/stripe-mpp/pay" || path === "/showcase/solana-mpp/pay")
      ) {
        const showcaseResponse = handleShowcaseRoute(request, path);
        return wrapResponseWithCors(
          request,
          showcaseResponse ?? notFound(path),
          corsOptions,
        );
      }

      if (
        readonlyRoutes.has(path) ||
        showcaseRoutes.has(path) ||
        customerRoute !== null ||
        providerRoute !== null
      ) {
        return wrapResponseWithCors(request, methodNotAllowed(), corsOptions);
      }

      return wrapResponseWithCors(request, notFound(path), corsOptions);
    }

    switch (path) {
      case "/":
        return wrapResponseWithCors(
          request,
          json({ service: "flovia-bff", status: "ok" }),
          corsOptions,
        );
      case "/health":
        return wrapResponseWithCors(
          request,
          json({
            status: "ok",
            service: "flovia-bff",
            commitHash: runtimeMetadata.commitHash,
            startedAt: runtimeMetadata.startedAt,
            memory: memoryUsageMib(),
            ...analyticsStatusBody(),
          }),
          corsOptions,
        );
      case "/ready":
        if (analyticsState.status === "loading") {
          return wrapResponseWithCors(
            request,
            json(
              {
                status: "loading",
                service: "flovia-bff",
                ...analyticsStatusBody(),
              },
              { status: 503 },
            ),
            corsOptions,
          );
        }
        if (analyticsState.status === "failed") {
          return wrapResponseWithCors(
            request,
            json(
              {
                status: "unavailable",
                service: "flovia-bff",
                ...analyticsStatusBody(),
              },
              { status: 503 },
            ),
            corsOptions,
          );
        }
        return wrapResponseWithCors(
          request,
          json({
            status: "ok",
            service: "flovia-bff",
            ...analyticsStatusBody(),
          }),
          corsOptions,
        );
      case "/aeo/x402": {
        // Independent of the analytics read model — served from the discovery store.
        // `service` may be a comma-separated list of candidate hosts; the first
        // host with discovery data wins (providers may not publish a serviceUrl,
        // so the frontend also passes observed/MPP endpoint hosts).
        const hosts = (url.searchParams.get("service") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        if (hosts.length === 0) {
          return wrapResponseWithCors(
            request,
            badRequest("Query parameter 'service' is required."),
            corsOptions,
          );
        }
        for (const host of hosts) {
          const aggregate = x402Store.getAggregate(host);
          if (aggregate) return wrapResponseWithCors(request, cachedJson(aggregate), corsOptions);
        }
        return wrapResponseWithCors(request, notFound(path), corsOptions);
      }
      default:
        break;
    }

    const showcaseResponse = handleShowcaseRoute(request, path);
    if (showcaseResponse) {
      return wrapResponseWithCors(request, showcaseResponse, corsOptions);
    }

    if (!readonlyRoutes.has(path) && customerRoute === null && providerRoute === null) {
      return wrapResponseWithCors(request, notFound(path), corsOptions);
    }

    const activeDataSource = getReadyDataSource();
    if (!activeDataSource) {
      return wrapResponseWithCors(
        request,
        analyticsState.status === "loading"
          ? analyticsLoading()
          : analyticsUnavailable(analyticsState.error),
        corsOptions,
      );
    }

    switch (path) {
      case "/providers":
        return wrapResponseWithCors(request, cachedJson(activeDataSource.providersList), corsOptions);
      case "/customers": {
        const serviceId = url.searchParams.get("serviceId");
        if (serviceId) {
          return wrapResponseWithCors(
            request,
            cachedJson(activeDataSource.getCustomersByServiceId(serviceId)),
            corsOptions,
          );
        }
        return wrapResponseWithCors(
          request,
          cachedJson(activeDataSource.getCustomers(url.searchParams.get("payTo") ?? undefined)),
          corsOptions,
        );
      }
      case "/wallet-usage-graph":
        return wrapResponseWithCors(
          request,
          cachedJson(activeDataSource.walletUsageGraph),
          corsOptions,
        );
      case "/analytics/services/coingecko/summary":
        return wrapResponseWithCors(
          request,
          cachedJson(activeDataSource.serviceSummary),
          corsOptions,
        );
      case "/analytics/services/comparison":
        return wrapResponseWithCors(
          request,
          cachedJson(activeDataSource.serviceComparison),
          corsOptions,
        );
      case "/analytics/services/quadrants":
        return wrapResponseWithCors(
          request,
          cachedJson(activeDataSource.serviceQuadrants),
          corsOptions,
        );
      case "/analytics/routes/summary":
        return wrapResponseWithCors(request, cachedJson(activeDataSource.routeSummary), corsOptions);
      case "/analytics/routes/sankey":
        return wrapResponseWithCors(request, cachedJson(activeDataSource.routeSankey), corsOptions);
      default:
        break;
    }

    if (providerRoute) {
      const provider = activeDataSource.getProviderById(providerRoute.providerId);
      return wrapResponseWithCors(
        request,
        provider ? cachedJson(provider) : notFound(path),
        corsOptions,
      );
    }

    if (customerRoute?.kind === "profile") {
      const normalizedAddress = normalizePaymentRecipientAddress(customerRoute.address);
      const profile = activeDataSource.getCustomerProfile(normalizedAddress);

      if (!profile) {
        return wrapResponseWithCors(request, notFound(path), corsOptions);
      }

      return wrapResponseWithCors(request, cachedJson(profile), corsOptions);
    }

    if (customerRoute?.kind === "intelligence") {
      const normalizedAddress = normalizePaymentRecipientAddress(customerRoute.address);
      const intelligence = activeDataSource.getCustomerIntelligence(normalizedAddress);

      if (!intelligence) {
        return wrapResponseWithCors(request, notFound(path), corsOptions);
      }

      return wrapResponseWithCors(request, cachedJson(intelligence), corsOptions);
    }

    if (customerRoute?.kind === "upsellMetrics") {
      const normalizedAddress = normalizePaymentRecipientAddress(customerRoute.address);
      const metrics = activeDataSource.getCustomerUpsellMetrics(normalizedAddress);

      if (!metrics) {
        return wrapResponseWithCors(request, notFound(path), corsOptions);
      }

      return wrapResponseWithCors(request, cachedJson(metrics), corsOptions);
    }

    if (customerRoute?.kind === "upsellExplanation") {
      const normalizedAddress = normalizePaymentRecipientAddress(customerRoute.address);
      const metrics = activeDataSource.getCustomerUpsellMetrics(normalizedAddress);

      if (!metrics) {
        return wrapResponseWithCors(request, notFound(path), corsOptions);
      }

      if (!llmService) {
        return wrapResponseWithCors(request, llmUnavailable(), corsOptions);
      }

      try {
        // QVAC may need to download and load a local model on the first request.
        server?.timeout(request, 0);
        return wrapResponseWithCors(
          request,
          json(await llmService.generateUpsellExplanation(metrics)),
          corsOptions,
        );
      } catch (error) {
        if (error instanceof BffLlmUnavailableError) {
          return wrapResponseWithCors(request, llmUnavailable(), corsOptions);
        }
        console.error("LLM upsell explanation request failed.", error);
        return wrapResponseWithCors(request, llmFailed(error), corsOptions);
      }
    }

    if (customerRoute?.kind === "workflowIntent") {
      const normalizedAddress = normalizePaymentRecipientAddress(customerRoute.address);
      const profile = activeDataSource.getCustomerProfile(normalizedAddress);

      if (!profile) {
        return wrapResponseWithCors(request, notFound(path), corsOptions);
      }

      const selection = buildWorkflowIntentInputFromProfile(profile);
      const input = toWorkflowIntentInput(selection);

      if (!input) {
        return wrapResponseWithCors(
          request,
          workflowIntentNoCandidateSessions({
            address: normalizedAddress,
            profile,
            selection,
            input,
          }),
          corsOptions,
        );
      }

      const unavailableResponse = () =>
        wrapResponseWithCors(
          request,
          workflowIntentUnavailable({ address: normalizedAddress, profile, selection, input }),
          corsOptions,
        );

      if (!llmService) {
        return unavailableResponse();
      }

      try {
        server?.timeout(request, 0);
        const result = await llmService.generateWorkflowIntentExplanation({
          address: normalizedAddress,
          sourceGeneratedAt: profile.generatedAt,
          input,
        });

        return wrapResponseWithCors(
          request,
          workflowIntentReady({
            address: normalizedAddress,
            profile,
            selection,
            input,
            result,
          }),
          corsOptions,
        );
      } catch (error) {
        if (error instanceof BffLlmUnavailableError) {
          return unavailableResponse();
        }
        console.error("Workflow intent request failed.", error);
        return wrapResponseWithCors(
          request,
          workflowIntentFailed({
            address: normalizedAddress,
            profile,
            selection,
            input,
            error,
          }),
          corsOptions,
        );
      }
    }

    return wrapResponseWithCors(request, notFound(path), corsOptions);
  };
};
