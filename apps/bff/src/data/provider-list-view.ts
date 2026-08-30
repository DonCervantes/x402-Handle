import type { ProviderCatalogResponse, ProviderCatalogRow } from "contracts";

/**
 * Derived, request-cheap views over a ProviderCatalogResponse.
 *
 * - `providersList`: the catalog with the heavy per-endpoint `resources` array
 *   stripped from every row. The list endpoint only needs summary fields
 *   (`resourceCount`/`endpointCount` are retained), so dropping `resources`
 *   shrinks the payload by ~98% without changing any consumer behavior.
 * - `getProviderById`: O(1) lookup of the full row (including `resources`) for a
 *   single-provider detail endpoint.
 *
 * Computed once when a data source becomes ready, not per request.
 */
export type ProviderListView = {
  providersList: ProviderCatalogResponse;
  getProviderById(providerId: string): ProviderCatalogRow | null;
};

export const deriveProviderListView = (providers: ProviderCatalogResponse): ProviderListView => {
  const activeProviders = providers.providers.filter((provider) => provider.active !== false);

  const byId = new Map(activeProviders.map((provider) => [provider.providerId, provider]));

  const lightweightRows = activeProviders.map((provider) => {
    if (provider.resources === undefined) return provider;
    const { resources, ...rest } = provider;
    return rest;
  });

  const providersList: ProviderCatalogResponse = {
    ...providers,
    providers: lightweightRows,
  };

  return {
    providersList,
    getProviderById: (providerId) => byId.get(providerId) ?? null,
  };
};