export interface ReplayStore {
  /**
   * Atomically marks a transaction hash as consumed. Only the first caller
   * for a hash succeeds; implementations must never expire successful claims.
   */
  claim(txHash: string): Promise<boolean>;
}

const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

export function normalizeTxHash(txHash: string): string | null {
  return TX_HASH_RE.test(txHash) ? txHash.toLowerCase() : null;
}

export function requireTxHash(txHash: string): string {
  const normalized = normalizeTxHash(txHash);
  if (!normalized) throw new Error(`invalid tx hash: ${JSON.stringify(txHash)}`);
  return normalized;
}

/** Process-local only; use a persistent shared adapter in deployed services. */
export function createMemoryReplayStore(): ReplayStore {
  const consumed = new Set<string>();

  return {
    async claim(txHash) {
      const normalized = requireTxHash(txHash);
      if (consumed.has(normalized)) return false;
      consumed.add(normalized);
      return true;
    },
  };
}
