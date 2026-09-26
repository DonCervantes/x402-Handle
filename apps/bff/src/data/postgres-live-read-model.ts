import type {
  BffAnalyticsDataSource,
  GeneratedReadModelFile,
  PostgresAnalyticsClient,
} from "./analytics-source";
import {
  loadPostgresLiveAnalyticsDataSource as loadDataSourceImpl,
  loadPostgresLiveAnalyticsPayload as loadPayloadImpl,
} from "./postgres-live/source";

export function validatePostgresAnalyticsClient(
  client: unknown,
): asserts client is PostgresAnalyticsClient {
  if (!client || typeof client !== "object") {
    throw new TypeError("Invalid postgres client: client must be a non-null object");
  }
  if (!("query" in client) || typeof (client as Record<string, unknown>).query !== "function") {
    throw new TypeError("Invalid postgres client: client must implement a query method");
  }
}

export const loadPostgresLiveAnalyticsPayload = async (
  client: PostgresAnalyticsClient,
): Promise<GeneratedReadModelFile> => {
  validatePostgresAnalyticsClient(client);
  return loadPayloadImpl(client);
};

export const loadPostgresLiveAnalyticsDataSource = async (
  client: PostgresAnalyticsClient,
): Promise<BffAnalyticsDataSource> => {
  validatePostgresAnalyticsClient(client);
  return loadDataSourceImpl(client);
};

export async function main(
  client?: PostgresAnalyticsClient,
): Promise<GeneratedReadModelFile | null> {
  if (!client) {
    return null;
  }
  validatePostgresAnalyticsClient(client);
  return loadPostgresLiveAnalyticsPayload(client);
}
