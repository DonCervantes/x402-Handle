import { describe, expect, test } from "bun:test";
import { createMemoryReplayStore, normalizeTxHash, type ReplayStore } from "../src/replay-store";
import { createPostgresReplayStore, type PostgresReplaySql } from "../src/replay-store-postgres";
import { createRedisReplayStore, type RedisReplayClient } from "../src/replay-store-redis";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

/** Minimal Postgres stand-in that honours PRIMARY KEY + ON CONFLICT DO NOTHING. */
function fakePostgres() {
  const rows = new Map<string, Date>();
  const queries: string[] = [];
  const sql: PostgresReplaySql = {
    async unsafe(query: string, params: unknown[] = []) {
      queries.push(query);
      if (query.startsWith("CREATE")) return [];
      const hash = params[0] as string;
      if (query.includes("INSERT")) {
        if (rows.has(hash)) return [];
        rows.set(hash, new Date());
        return [{ tx_hash: hash }];
      }
      if (query.includes("SELECT")) return rows.has(hash) ? [{ tx_hash: hash }] : [];
      throw new Error(`unexpected query: ${query}`);
    },
  };
  return { sql, rows, queries };
}

/** Minimal Redis stand-in that honours SET ... NX. */
function fakeRedis() {
  const keys = new Map<string, string>();
  const commands: string[][] = [];
  const client: RedisReplayClient = {
    async send(command: string, args: string[]) {
      commands.push([command, ...args]);
      if (command === "SET") {
        const [key, value, ...flags] = args;
        if (flags.includes("NX") && keys.has(key)) return null;
        keys.set(key, value);
        return "OK";
      }
      if (command === "EXISTS") return keys.has(args[0]) ? 1 : 0;
      throw new Error(`unexpected command: ${command}`);
    },
  };
  return { client, keys, commands };
}

describe("normalizeTxHash", () => {
  test("lowercases a valid 64-char hex hash", () => {
    expect(normalizeTxHash("A".repeat(64))).toBe("a".repeat(64));
  });

  test("rejects anything that is not a 64-char hex hash", () => {
    expect(normalizeTxHash("")).toBeNull();
    expect(normalizeTxHash("a".repeat(63))).toBeNull();
    expect(normalizeTxHash(`${"a".repeat(63)}g`)).toBeNull();
    expect(normalizeTxHash(` ${HASH}`)).toBeNull();
  });
});

const contract = (name: string, make: () => ReplayStore) => {
  describe(`${name} replay store contract`, () => {
    test("claim succeeds exactly once per hash", async () => {
      const store = make();
      expect(await store.claim(HASH)).toBe(true);
      expect(await store.claim(HASH)).toBe(false);
      expect(await store.claim(OTHER)).toBe(true);
    });

    test("has() reflects consumed hashes", async () => {
      const store = make();
      expect(await store.has(HASH)).toBe(false);
      await store.claim(HASH);
      expect(await store.has(HASH)).toBe(true);
    });

    test("concurrent claims for one hash yield a single winner", async () => {
      const store = make();
      const results = await Promise.all(Array.from({ length: 20 }, () => store.claim(HASH)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    test("rejects malformed hashes instead of storing them", async () => {
      const store = make();
      await expect(store.claim("not-a-hash")).rejects.toThrow(/invalid tx hash/);
    });
  });
};

contract("memory", () => createMemoryReplayStore());
contract("postgres", () => createPostgresReplayStore({ sql: fakePostgres().sql }));
contract("redis", () => createRedisReplayStore({ client: fakeRedis().client }));

describe("memory replay store", () => {
  test("never expires consumed hashes", async () => {
    let now = 0;
    const store = createMemoryReplayStore({ now: () => now });
    await store.claim(HASH);
    now = 365 * 24 * 60 * 60 * 1000;
    expect(await store.has(HASH)).toBe(true);
    expect(await store.claim(HASH)).toBe(false);
  });
});

describe("postgres replay store", () => {
  test("claims atomically with INSERT ... ON CONFLICT DO NOTHING and no expiry", async () => {
    const pg = fakePostgres();
    const store = createPostgresReplayStore({ sql: pg.sql });
    await store.claim(HASH);
    const insert = pg.queries.find((q) => q.includes("INSERT")) ?? "";
    expect(insert).toContain("ON CONFLICT (tx_hash) DO NOTHING");
    expect(insert).toContain("RETURNING tx_hash");
    expect(pg.queries.join("\n")).not.toMatch(/DELETE|expires|interval/i);
  });

  test("ensureSchema creates a primary-keyed table", async () => {
    const pg = fakePostgres();
    await createPostgresReplayStore({ sql: pg.sql }).ensureSchema();
    expect(pg.queries[0]).toContain("CREATE TABLE IF NOT EXISTS x402_consumed_payments");
    expect(pg.queries[0]).toContain("tx_hash TEXT PRIMARY KEY");
  });

  test("accepts a custom, safe table name", async () => {
    const pg = fakePostgres();
    await createPostgresReplayStore({ sql: pg.sql, table: "billing.x402_replay" }).claim(HASH);
    expect(pg.queries[0]).toContain("INSERT INTO billing.x402_replay");
  });

  test("rejects unsafe table identifiers", () => {
    expect(() =>
      createPostgresReplayStore({ sql: fakePostgres().sql, table: "x; DROP TABLE y" }),
    ).toThrow(/invalid table/);
  });
});

describe("redis replay store", () => {
  test("claims with SET NX and never sets a TTL", async () => {
    const redis = fakeRedis();
    await createRedisReplayStore({ client: redis.client }).claim(HASH);
    const [command, key, , ...flags] = redis.commands[0];
    expect(command).toBe("SET");
    expect(key).toBe(`x402:consumed:${HASH}`);
    expect(flags).toEqual(["NX"]);
  });

  test("uses a custom key prefix", async () => {
    const redis = fakeRedis();
    await createRedisReplayStore({ client: redis.client, keyPrefix: "handle:tx:" }).claim(HASH);
    expect(redis.keys.has(`handle:tx:${HASH}`)).toBe(true);
  });
});
