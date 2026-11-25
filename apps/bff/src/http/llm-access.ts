import { timingSafeEqual } from "node:crypto";
import { forbidden, tooManyRequests, unauthorized } from "./responses";

const DEFAULT_MAX_CALLS = 60;
const DEFAULT_WINDOW_MS = 60_000;

export type LlmAccessConfig = {
  /** Bearer credential. `null` disables all LLM/upsell routes (403). */
  apiKey: string | null;
  /** Maximum authorized calls per fixed window, shared by all LLM routes. */
  maxCalls: number;
  /** Length of the quota window in milliseconds. */
  windowMs: number;
  /** Injectable clock so quota windows are deterministic in tests. */
  now?: () => number;
};

export type LlmAccessGuard = {
  /** Returns an error response when the request is denied, otherwise `null`. */
  authorize: (request: Request) => Response | null;
};

const positiveInteger = (raw: string | undefined, fallback: number): number => {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const resolveLlmAccessConfig = (env: NodeJS.ProcessEnv): LlmAccessConfig => ({
  apiKey: env.BFF_LLM_API_KEY?.trim() || null,
  maxCalls: positiveInteger(env.BFF_LLM_RATE_LIMIT_MAX, DEFAULT_MAX_CALLS),
  windowMs: positiveInteger(env.BFF_LLM_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS),
});

const tokensMatch = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Single fixed-window quota per BFF instance. The guard is created once per
 * handler, so state does not leak between independently created handlers.
 */
export const createLlmAccessGuard = (config: LlmAccessConfig): LlmAccessGuard => {
  const now = config.now ?? Date.now;
  let windowStart = now();
  let calls = 0;

  return {
    authorize(request) {
      if (!config.apiKey) {
        return forbidden("LLM and upsell routes are disabled (set BFF_LLM_API_KEY to enable).");
      }

      const authorization = request.headers.get("authorization");
      const bearer = authorization?.toLowerCase().startsWith("bearer ")
        ? authorization.slice(7).trim()
        : "";
      const provided = bearer || request.headers.get("x-api-key")?.trim() || "";
      if (!provided || !tokensMatch(provided, config.apiKey)) {
        return unauthorized("Invalid LLM API credential.");
      }

      const current = now();
      if (current - windowStart >= config.windowMs) {
        windowStart = current;
        calls = 0;
      }

      if (calls >= config.maxCalls) {
        const remainingMs = Math.max(0, config.windowMs - (current - windowStart));
        return tooManyRequests(Math.max(1, Math.ceil(remainingMs / 1000)));
      }

      calls += 1;
      return null;
    },
  };
};
