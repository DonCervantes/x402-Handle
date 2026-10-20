// code/x402-stellar-middleware/src/challenge-store.ts
//
// Almacén en memoria de challenges/memos emitidos por este servidor.
// Asegura el binding entre el challenge emitido y el pago verificado,
// evitando que un pagador use memos arbitrarios no autorizados.

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutos por defecto

export interface ChallengeRecord {
  memo: string;
  destination: string;
  amount: string;
  network: "testnet" | "public";
  asset: { code: "USDC"; issuer: string };
  expiresAt: number; // timestamp en ms
}

export interface ChallengeStore {
  has(memo: string): boolean;
  get(memo: string): ChallengeRecord | undefined;
  add(challenge: ChallengeRecord): void;
  consume(memo: string): void;
  size(): number;
  clear(): void;
}

export function createChallengeStore(opts: { ttlMs?: number } = {}): ChallengeStore {
  const defaultTtl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const store = new Map<string, ChallengeRecord>();

  function purgeExpired() {
    const now = Date.now();
    for (const [memo, entry] of store) {
      if (now > entry.expiresAt) store.delete(memo);
    }
  }

  return {
    has(memo: string): boolean {
      const entry = store.get(memo);
      if (!entry) return false;
      if (Date.now() > entry.expiresAt) {
        store.delete(memo);
        return false;
      }
      return true;
    },
    get(memo: string): ChallengeRecord | undefined {
      const entry = store.get(memo);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(memo);
        return undefined;
      }
      return entry;
    },
    add(challenge: ChallengeRecord): void {
      purgeExpired();
      store.set(challenge.memo, {
        ...challenge,
        expiresAt: challenge.expiresAt ?? Date.now() + defaultTtl,
      });
    },
    consume(memo: string): void {
      store.delete(memo);
    },
    size(): number {
      purgeExpired();
      return store.size;
    },
    clear(): void {
      store.clear();
    },
  };
}

// Store singleton por defecto (se puede overridear en config)
export const defaultChallengeStore = createChallengeStore();
