import { describe, expect, test } from "bun:test";
import { createMemoryReplayStore, normalizeTxHash, type ReplayStore } from "../src/replay-store";
import { createPostgresReplayStore, type PostgresReplaySql } from "../src/replay-store-postgres";
import { createRedisReplayStore, type RedisReplayClient } from "../src/replay-store-redis";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function fakePostgres() {
  const consumed = new Set<string>();
  const queries: string[] = [];
  const sql: PostgresReplaySql = {
    async unsafe(query, params = []) {
      queries.push(query);
      if (query.startsWith("CREATE")) return [];
      const txHash = params[0] as string;
      if (consumed.has(txHash)) return [];
      consumed.add(txHash);
      return [{ tx_hash: txHash }];
    },
  };
  return { sql, queries };
}

function fakeRedis() {
  const consumed = new Set<string>();
  const commands: string[][] = [];
  const client: RedisReplayClient = {
    async send(command, args) {
      commands.push([command, ...args]);
      if (command !== "SET") throw new Error(`unexpected command: ${command}`);
      const [key, , ...flags] = args;
      if (consumed.has(key)) return null;
      consumed.add(key);
      if (flags.join(" ") !== "NX") throw new Error("Redis claim must use NX without a TTL");
      return "OK";
    },
  };
  return { client, commands };
}

describe("normalizeTxHash", () => {
  test("normalizes valid hashes to lowercase", () => {
    expect(normalizeTxHash("A".repeat(64))).toBe(HASH);
  });

  test("rejects malformed hashes", () => {
    expect(normalizeTxHash("a".repeat(63))).toBeNull();
    expect(normalizeTxHash(`${HASH.slice(1)}g`)).toBeNull();
  });
});

describe("replay stores", () => {
  const adapters: Array<[string, () => ReplayStore]> = [
    ["memory", () => createMemoryReplayStore()],
    ["Postgres", () => createPostgresReplayStore({ sql: fakePostgres().sql })],
    ["Redis", () => createRedisReplayStore({ client: fakeRedis().client })],
  ];

  for (const [name, createStore] of adapters) {
    test(`${name} only allows one concurrent claim`, async () => {
      const store = createStore();
      const results = await Promise.all(Array.from({ length: 10 }, () => store.claim(HASH)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    test(`${name} retains claimed hashes`, async () => {
      const store = createStore();
      expect(await store.claim(HASH)).toBe(true);
      expect(await store.claim(HASH)).toBe(false);
    });
  }
});

test("Postgres and Redis stores share claims across instances", async () => {
  const pg = fakePostgres();
  const postgresA = createPostgresReplayStore({ sql: pg.sql });
  const postgresB = createPostgresReplayStore({ sql: pg.sql });
  expect(await postgresA.claim(HASH)).toBe(true);
  expect(await postgresB.claim(HASH)).toBe(false);
  expect(pg.queries[0]).toContain("ON CONFLICT (tx_hash) DO NOTHING RETURNING tx_hash");
  expect(pg.queries.join("\n")).not.toMatch(/DELETE|expires|interval/i);

  const redis = fakeRedis();
  const redisA = createRedisReplayStore({ client: redis.client });
  const redisB = createRedisReplayStore({ client: redis.client });
  expect(await redisA.claim(OTHER_HASH)).toBe(true);
  expect(await redisB.claim(OTHER_HASH)).toBe(false);
  expect(redis.commands[0]).toEqual(["SET", `x402:consumed:${OTHER_HASH}`, "1", "NX"]);
});

test("memory store keeps claimed hashes for its lifetime", async () => {
  const store = createMemoryReplayStore();
  expect(await store.claim(HASH)).toBe(true);
  expect(await store.claim(HASH)).toBe(false);
});
