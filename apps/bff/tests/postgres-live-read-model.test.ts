import { describe, expect, test } from "bun:test";
import {
  main,
  validatePostgresAnalyticsClient,
  loadPostgresLiveAnalyticsPayload,
  loadPostgresLiveAnalyticsDataSource,
} from "../src/data/postgres-live-read-model";

describe("postgres-live-read-model boundary handling", () => {
  test("validatePostgresAnalyticsClient throws TypeError on null or undefined", () => {
    expect(() => validatePostgresAnalyticsClient(null)).toThrow(TypeError);
    expect(() => validatePostgresAnalyticsClient(undefined)).toThrow(TypeError);
    expect(() => validatePostgresAnalyticsClient(123)).toThrow(TypeError);
    expect(() => validatePostgresAnalyticsClient("string")).toThrow(TypeError);
  });

  test("validatePostgresAnalyticsClient throws TypeError on object without query method", () => {
    expect(() => validatePostgresAnalyticsClient({})).toThrow(TypeError);
    expect(() => validatePostgresAnalyticsClient({ query: "not-a-function" })).toThrow(TypeError);
  });

  test("validatePostgresAnalyticsClient accepts valid client", () => {
    const valid = { query: async () => [] };
    expect(() => validatePostgresAnalyticsClient(valid)).not.toThrow();
  });

  test("main returns null when client is omitted", async () => {
    const result = await main();
    expect(result).toBeNull();
  });

  test("main throws TypeError when invalid client is provided", async () => {
    expect(main({} as any)).rejects.toThrow(TypeError);
  });

  test("main executes with valid mock client and returns payload", async () => {
    const mockClient = {
      async query(sql: string) {
        if (sql.includes("attributed_grouped")) {
          return [
            {
              customer_account: "0x1111111111111111111111111111111111111111",
              provider_id: "live-service",
              catalog_source: "pay_sh_curated",
              first_seen_at: "2026-05-01T00:00:00.000Z",
              last_seen_at: "2026-05-02T00:00:00.000Z",
              transfer_count: 1,
              unique_sender_count: 1,
              total_volume_atomic: "100",
            },
          ];
        }
        if (sql.includes("provider_activity")) {
          return [
            {
              provider_id: "live-service",
              catalog_source: "pay_sh_curated",
              first_seen_at: "2026-05-01T00:00:00.000Z",
              last_seen_at: "2026-05-02T00:00:00.000Z",
              transfer_count: 1,
              unique_sender_count: 1,
              total_volume_atomic: "100",
            },
          ];
        }
        return [];
      },
    };

    const payload = await main(mockClient);
    expect(payload).not.toBeNull();
    expect((payload?.serviceSummary as { generatedFrom?: string } | undefined)?.generatedFrom).toBe(
      "postgres-live-read-model",
    );
  });
});
