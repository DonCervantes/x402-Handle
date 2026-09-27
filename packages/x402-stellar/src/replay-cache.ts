// code/x402-stellar-middleware/src/replay-cache.ts
//
// Cache en memoria de tx_hashes que ya se consumieron como pago válido.
// Previene replay attacks: una misma tx no puede comprar dos veces el recurso.
//
// Para producción multi-instancia, reemplazar por Redis o por log on-chain
// (log_payment en el contrato Soroban actúa como replay cache distribuido).

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CacheEntry {
  txHash: string;
  consumedAt: number;
}

export interface ReplayCache {
  has(txHash: string): boolean;
  add(txHash: string): void;
  /**
   * Reclama `txHash` para quien llama: devuelve `true` si y sólo si esta
   * llamada insertó el hash (insert-if-absent), y `false` si ya estaba
   * consumido y vigente.
   *
   * Es la primitiva que debe usar el middleware para otorgar acceso: es
   * síncrona, así que no hay ningún `await` entre el check y el insert y dos
   * verificaciones concurrentes de la misma tx no pueden ganar las dos.
   */
  consume(txHash: string): boolean;
  size(): number;
}

export function createReplayCache(opts: { ttlMs?: number } = {}): ReplayCache {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const store = new Map<string, CacheEntry>();

  // Purga lazy: cada vez que insertamos algo, limpiamos lo viejo.
  function purgeExpired(now: number) {
    for (const [hash, entry] of store) {
      if (now - entry.consumedAt > ttl) store.delete(hash);
    }
  }

  function isLive(entry: CacheEntry | undefined, now: number): entry is CacheEntry {
    return entry !== undefined && now - entry.consumedAt <= ttl;
  }

  return {
    has(txHash: string): boolean {
      const now = Date.now();
      const entry = store.get(txHash);
      if (!isLive(entry, now)) {
        // Un hash expirado se trata como nunca consumido (y se libera).
        if (entry) store.delete(txHash);
        return false;
      }
      return true;
    },
    add(txHash: string): void {
      const now = Date.now();
      purgeExpired(now);
      store.set(txHash, { txHash, consumedAt: now });
    },
    consume(txHash: string): boolean {
      const now = Date.now();
      const entry = store.get(txHash);
      if (isLive(entry, now)) return false;
      // El hash está libre (nunca visto, o visto pero expirado): lo reclamamos
      // en el acto. `store.set` es síncrono, así que este check-and-set es
      // indivisible dentro del event loop: dos llamadas concurrentes no pueden
      // devolver `true` las dos.
      if (entry) store.delete(txHash);
      store.set(txHash, { txHash, consumedAt: now });
      return true;
    },
    size(): number {
      return store.size;
    },
  };
}

// Cache singleton por defecto (se puede overridear en config)
export const defaultReplayCache = createReplayCache();
