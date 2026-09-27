// Replay protection for x402 payments.
//
// A Stellar tx hash that bought a resource once must never buy it again —
// not after a TTL, not after a restart, not on another replica. Stores
// therefore never expire consumed hashes, and `claim` must be atomic
// (set-if-absent) so two concurrent redemptions of one payment cannot both
// win.
//
// Adapters:
//   - replay-store-postgres.ts → INSERT ... ON CONFLICT DO NOTHING (durable)
//   - replay-store-redis.ts    → SET key value NX, no TTL (durable if Redis
//                                persistence is enabled)
//   - createMemoryReplayStore  → tests / single-process local dev only

export interface ReplayStore {
  /** True if the hash has already been consumed. Advisory fast-path only. */
  has(txHash: string): Promise<boolean>;
  /**
   * Atomically marks the hash as consumed. Resolves `true` for exactly one
   * caller per hash; every later (or concurrent) caller gets `false`.
   */
  claim(txHash: string): Promise<boolean>;
}

const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Canonical form of a Stellar tx hash (64 lowercase hex chars), or `null`
 * when the input is not a tx hash. Horizon accepts either case, so storing
 * the raw header value would let `ABC…` replay a payment consumed as `abc…`.
 */
export function normalizeTxHash(txHash: string): string | null {
  return TX_HASH_RE.test(txHash) ? txHash.toLowerCase() : null;
}

/** Normalizes or throws; used by adapters so bad input never reaches storage. */
export function requireTxHash(txHash: string): string {
  const normalized = normalizeTxHash(txHash);
  if (!normalized) throw new Error(`invalid tx hash: ${JSON.stringify(txHash)}`);
  return normalized;
}

/**
 * Process-local store. State is lost on restart and not shared between
 * replicas, so it must not back a production deployment.
 */
export function createMemoryReplayStore(opts: { now?: () => number } = {}): ReplayStore {
  const now = opts.now ?? Date.now;
  const consumed = new Map<string, number>();

  return {
    async has(txHash) {
      return consumed.has(requireTxHash(txHash));
    },
    async claim(txHash) {
      const key = requireTxHash(txHash);
      if (consumed.has(key)) return false;
      consumed.set(key, now());
      return true;
    },
  };
}
