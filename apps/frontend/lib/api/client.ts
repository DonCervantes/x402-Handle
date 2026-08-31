import {
  type AeoDiscovery,
  type PhaseBCustomerProfileResponse,
  type ProviderIntelligence,
  type RouteAnalyticsSankeyResponse,
  type RouteAnalyticsSummaryResponse,
  type StatsOverview,
  type StellarProvider,
  type WalletUsageGraphResponse,
  validateAeoDiscoveryResponse,
  validatePhaseBCustomerListResponse,
  validatePhaseBCustomerUpsellExplanationResponse,
  validatePhaseBCustomerProfileResponse,
  validatePhaseBWalletUsageGraphResponse,
  validateProviderCatalogResponse,
  validateProviderIntelligenceResponse,
  validateRouteAnalyticsSankeyResponse,
  validateRouteAnalyticsSummaryResponse,
  validateStatsOverviewResponse,
  validateStellarProviderListResponse,
  validateStellarProviderResponse,
} from "contracts";
import {
  adaptCustomerList,
  adaptCustomerProfile,
  adaptCustomerUpsellExplanation,
  adaptObservationsFromGraph,
  adaptProviderCatalog,
  adaptSummaryFromCustomers,
  adaptWalletUsageGraph,
} from "./adapters";
import type {
  CustomerListItemDto,
  CustomerProfileDto,
  CustomerUpsellExplanationDto,
  PaymentObservationDto,
  ProviderCatalogItemDto,
  ReportSummaryDto,
  WalletUsageGraphDto,
} from "./types";

const DEFAULT_BFF_URL = "http://localhost:3001";
const DEFAULT_PUBLIC_BFF_URL = "/api";
const SNAPSHOT_REVALIDATE_SECONDS = 60;
// Cap snapshot-backed BFF requests so a slow/cold BFF cannot hang a server
// render (and the navigation that awaits it) indefinitely. LLM endpoints opt
// out of this — they are intentionally long-running.
const SNAPSHOT_FETCH_TIMEOUT_MS = 20 * 1000;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function bffBaseUrl(): string {
  const isServer = typeof window === "undefined";

  if (isServer) {
    const url = process.env.BFF_URL ?? DEFAULT_BFF_URL;
    return stripTrailingSlash(url);
  }

  const url = process.env.NEXT_PUBLIC_BFF_URL ?? DEFAULT_PUBLIC_BFF_URL;
  return stripTrailingSlash(url);
}

async function bffFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${bffBaseUrl()}${path}`, {
    next: { revalidate: SNAPSHOT_REVALIDATE_SECONDS },
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Data request failed: ${response.status} ${response.statusText} (${path})`);
  }

  return (await response.json()) as T;
}

export async function getCustomerProfile(address: string): Promise<CustomerProfileDto | null> {
  const raw = await getCustomerProfileRaw(address);
  if (!raw) return null;
  return adaptCustomerProfile(raw);
}

export async function getCustomerProfileRaw(
  address: string,
): Promise<PhaseBCustomerProfileResponse | null> {
  const response = await fetch(`${bffBaseUrl()}/customers/${encodeURIComponent(address)}/profile`, {
    next: { revalidate: SNAPSHOT_REVALIDATE_SECONDS },
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Data request failed: ${response.status} ${response.statusText} (/customers/${address}/profile)`,
    );
  }
  return validatePhaseBCustomerProfileResponse(await response.json());
}

export async function getCustomerUpsellExplanation(
  address: string,
): Promise<CustomerUpsellExplanationDto | null> {
  const response = await fetch(
    `${bffBaseUrl()}/customers/${encodeURIComponent(address)}/llm/upsell-explanation`,
    {
      cache: "no-store",
      headers: { accept: "application/json" },
    },
  );

  if (response.status === 404 || response.status === 503) return null;
  // LLM routes are gated behind BFF_LLM_API_KEY; treat a disabled (403) or
  // quota-exceeded (429) route as unavailable so the demo degrades gracefully.
  if (response.status === 403 || response.status === 429) return null;
  if (!response.ok) {
    throw new Error(
      `Data request failed: ${response.status} ${response.statusText} (/customers/${address}/llm/upsell-explanation)`,
    );
  }

  return adaptCustomerUpsellExplanation(
    validatePhaseBCustomerUpsellExplanationResponse(await response.json()),
  );
}

export async function getProviders(): Promise<ProviderCatalogItemDto[]> {
  return adaptProviderCatalog(
    validateProviderCatalogResponse(await bffFetch<unknown>("/providers")),
  );
}

// Aggregated x402 facilitator discovery for the AEO page. `services` is one or
// more candidate hosts (a provider may not publish a serviceUrl, so the caller
// also passes observed/MPP endpoint hosts); the BFF returns the first match.
export async function getAeoX402Discovery(
  services: string | string[],
): Promise<AeoDiscovery | null> {
  const candidates = (Array.isArray(services) ? services : [services])
    .map((value) => value.trim())
    .filter(Boolean);
  if (candidates.length === 0) return null;

  const response = await fetch(
    `${bffBaseUrl()}/aeo/x402?service=${encodeURIComponent(candidates.join(","))}`,
    {
      next: { revalidate: SNAPSHOT_REVALIDATE_SECONDS },
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
    },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Data request failed: ${response.status} ${response.statusText} (/aeo/x402)`);
  }

  return validateAeoDiscoveryResponse(await response.json());
}

// Registry Stellar (Día 4 BFF routes) — dominio separado del catálogo legacy
// multi-chain de arriba (getProviders/getCustomers).
export type StellarHealth = {
  status: "ok" | "degraded";
  horizon: boolean;
  soroban: boolean;
  database: boolean;
  registryContractId: string | null;
};

export async function getStellarProviders(): Promise<StellarProvider[]> {
  return validateStellarProviderListResponse(await bffFetch<unknown>("/stellar/providers"));
}

export async function getStellarProvider(id: string): Promise<StellarProvider | null> {
  const response = await fetch(`${bffBaseUrl()}/stellar/providers/${encodeURIComponent(id)}`, {
    next: { revalidate: SNAPSHOT_REVALIDATE_SECONDS },
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Data request failed: ${response.status} ${response.statusText} (/stellar/providers/${id})`,
    );
  }
  return validateStellarProviderResponse(await response.json());
}

export async function getStellarProviderIntelligence(
  id: string,
): Promise<ProviderIntelligence | null> {
  const response = await fetch(
    `${bffBaseUrl()}/stellar/providers/${encodeURIComponent(id)}/intelligence`,
    {
      next: { revalidate: SNAPSHOT_REVALIDATE_SECONDS },
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Data request failed: ${response.status} ${response.statusText} (/stellar/providers/${id}/intelligence)`,
    );
  }
  return validateProviderIntelligenceResponse(await response.json());
}

export async function getStellarHealth(): Promise<StellarHealth> {
  return bffFetch<StellarHealth>("/stellar/health");
}

export async function getStatsOverview(): Promise<StatsOverview> {
  return validateStatsOverviewResponse(await bffFetch<unknown>("/stats/overview"));
}

export type RankedStellarProvider = {
  provider: StellarProvider;
  trustScore: number;
  matchScore: number;
  reasons: string[];
};

export type RecommendStellarProvidersFilter = { category?: string; maxPriceUsdc?: number };

// Llamado client-side desde /playground — sin caché de Next (el usuario
// cambia los filtros en vivo).
export async function recommendStellarProviders(
  filter: RecommendStellarProvidersFilter = {},
): Promise<RankedStellarProvider[]> {
  const params = new URLSearchParams();
  if (filter.category) params.set("category", filter.category);
  if (filter.maxPriceUsdc !== undefined) params.set("maxPriceUsdc", String(filter.maxPriceUsdc));
  const query = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${bffBaseUrl()}/stellar/recommend${query}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Data request failed: ${response.status} ${response.statusText} (/stellar/recommend)`,
    );
  }
  return (await response.json()) as RankedStellarProvider[];
}

export type PlaygroundPayResult =
  | {
      ok: true;
      txHash: string;
      amountUsdc: string;
      memo: string;
      elapsedMs: number;
      data: unknown;
    }
  | { ok: false; error: string; message: string };

export async function runPlaygroundPayment(providerId: string): Promise<PlaygroundPayResult> {
  const response = await fetch(`${bffBaseUrl()}/stellar/playground/pay`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ providerId }),
  });
  return (await response.json()) as PlaygroundPayResult;
}

export type GetCustomersFilter = { payTo?: string; serviceId?: string };

export async function getCustomers(
  filter?: string | GetCustomersFilter,
): Promise<CustomerListItemDto[]> {
  const opts: GetCustomersFilter = typeof filter === "string" ? { payTo: filter } : (filter ?? {});
  const params = new URLSearchParams();
  if (opts.serviceId) params.set("serviceId", opts.serviceId);
  else if (opts.payTo) params.set("payTo", opts.payTo);
  const query = params.toString() ? `?${params.toString()}` : "";
  return adaptCustomerList(
    validatePhaseBCustomerListResponse(await bffFetch<unknown>(`/customers${query}`)),
  );
}

export async function getWalletUsageGraph(): Promise<WalletUsageGraphDto> {
  return adaptWalletUsageGraph(await getWalletUsageGraphRaw());
}

export async function getWalletUsageGraphRaw(): Promise<WalletUsageGraphResponse> {
  return validatePhaseBWalletUsageGraphResponse(await bffFetch<unknown>("/wallet-usage-graph"));
}

export async function getRouteAnalyticsSummary(): Promise<RouteAnalyticsSummaryResponse> {
  return validateRouteAnalyticsSummaryResponse(
    await bffFetch<unknown>("/analytics/routes/summary"),
  );
}

export async function getRouteAnalyticsSankey(): Promise<RouteAnalyticsSankeyResponse> {
  return validateRouteAnalyticsSankeyResponse(await bffFetch<unknown>("/analytics/routes/sankey"));
}

// Phase B BFF は /observations を提供しないため、/wallet-usage-graph から合成する。
// 用途: Patterns 画面の retention 計算 (payer x recipient ごとの first/last 比較)。
export async function getObservations(): Promise<PaymentObservationDto[]> {
  return adaptObservationsFromGraph(
    validatePhaseBWalletUsageGraphResponse(await bffFetch<unknown>("/wallet-usage-graph")),
  );
}

// Phase B BFF は /summary を提供しないため、/customers から合成する。
// freshness indicator (撤去済) 再導入用のヘルパー。詳細は
// docs/future-work.md "Data freshness indicator" を参照。
export async function getSummary(filter?: string | GetCustomersFilter): Promise<ReportSummaryDto> {
  const opts: GetCustomersFilter = typeof filter === "string" ? { payTo: filter } : (filter ?? {});
  const params = new URLSearchParams();
  if (opts.serviceId) params.set("serviceId", opts.serviceId);
  else if (opts.payTo) params.set("payTo", opts.payTo);
  const query = params.toString() ? `?${params.toString()}` : "";
  return adaptSummaryFromCustomers(
    validatePhaseBCustomerListResponse(await bffFetch<unknown>(`/customers${query}`)),
  );
}

// freshness indicator (撤去済) 再導入用のヘルパー。
// summary から最新観測の unix sec を選ぶ。フォールバック順:
//   1. observations[].blockTimestamp の max (秒精度)
//   2. dailyMetrics[].day を YYYY-MM-DD として UTC 0:00 の unix sec に変換した max
//   3. どちらも空 / 0 -> undefined
export function pickLatestObservationUnixSec(summary: ReportSummaryDto): number | undefined {
  const obsMax = summary.observations.reduce<number>(
    (acc, observation) => (observation.blockTimestamp > acc ? observation.blockTimestamp : acc),
    0,
  );
  if (obsMax > 0) return obsMax;

  const dayMax = summary.dailyMetrics.reduce<number>((acc, metric) => {
    const parsed = Date.parse(`${metric.day}T00:00:00Z`);
    if (Number.isNaN(parsed)) return acc;
    const sec = Math.floor(parsed / 1000);
    return sec > acc ? sec : acc;
  }, 0);
  if (dayMax > 0) return dayMax;

  return undefined;
}
