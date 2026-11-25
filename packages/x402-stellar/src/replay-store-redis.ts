import { requireTxHash, type ReplayStore } from "./replay-store";

export interface RedisReplayClient {
  send(command: string, args: string[]): Promise<unknown>;
}

export interface RedisReplayStoreOpts {
  client: RedisReplayClient;
  keyPrefix?: string;
}

/** Redis must use persistent storage and a no-eviction policy for these keys. */
export function createRedisReplayStore(opts: RedisReplayStoreOpts): ReplayStore {
  const prefix = opts.keyPrefix ?? "x402:consumed:";

  return {
    async claim(txHash) {
      const key = prefix + requireTxHash(txHash);
      const reply = await opts.client.send("SET", [key, "1", "NX"]);
      return reply === "OK";
    },
  };
}
