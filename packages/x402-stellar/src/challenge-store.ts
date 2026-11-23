// packages/x402-stellar/src/challenge-store.ts
//
// In-memory registry of the memos issued in 402 challenges. The middleware
// must remember the amount/destination it committed to when it created a
// challenge; otherwise a client could pick an arbitrary memo and expect the
// server to trust it. Keeping the state behind an interface makes it
// injectable (Redis/DB in multi-instance deployments) and cleanable in tests.

export interface IssuedMemo {
  /** ISO-8601 timestamp — same value returned in the 402 challenge. */
  expires_at: string;
  /** USDC amount committed to in the challenge. */
  amount: string;
  /** Stellar account the payment was requested for. */
  destination: string;
}

export interface ChallengeStore {
  issue(memo: string, challenge: IssuedMemo): void;
  get(memo: string): IssuedMemo | undefined;
  consume(memo: string): void;
  clear(): void;
  size(): number;
}

export function createChallengeStore(): ChallengeStore {
  const memos = new Map<string, IssuedMemo>();

  return {
    issue(memo, challenge) {
      memos.set(memo, challenge);
    },
    get(memo) {
      return memos.get(memo);
    },
    consume(memo) {
      memos.delete(memo);
    },
    clear() {
      memos.clear();
    },
    size() {
      return memos.size;
    },
  };
}

/** Default per-process store. Override via `challengeStore` in middleware opts. */
export const defaultChallengeStore = createChallengeStore();
