// Redis-backed ReplayStore using `SET key value NX` with no EX/PX, so a
// consumed hash never expires. Durability depends on the Redis deployment:
// enable AOF (appendonly yes) and disable eviction of these keys
// (maxmemory-policy noeviction), or prefer the Postgres adapter.

import { type ReplayStore, requireTxHash } from "./replay-store";

/** Structural subset of Bun's `RedisClient` (`send(command, args)`). */
export interface RedisReplayClient {
  send(command: string, args: string[]): Promise<unknown>;
}

export interface RedisReplayStoreOpts {
  client: RedisReplayClient;
  /** Default: "x402:consumed:". */
  keyPrefix?: string;
  now?: () => Date;
}

export function createRedisReplayStore(opts: RedisReplayStoreOpts): ReplayStore {
  const prefix = opts.keyPrefix ?? "x402:consumed:";
  const now = opts.now ?? (() => new Date());

  return {
    async has(txHash) {
      const exists = await opts.client.send("EXISTS", [prefix + requireTxHash(txHash)]);
      return Number(exists) > 0;
    },
    async claim(txHash) {
      const key = prefix + requireTxHash(txHash);
      const reply = await opts.client.send("SET", [key, now().toISOString(), "NX"]);
      return reply === "OK";
    },
  };
}
