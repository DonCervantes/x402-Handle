import { timingSafeEqual } from "node:crypto";
import { forbidden, rateLimited, unauthorized } from "./responses";

export type LlmGateOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

const DEFAULT_LLM_QUOTA_MAX = 30;
const DEFAULT_LLM_QUOTA_WINDOW_MS = 60_000;

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const extractApiKey = (request: Request): string | null => {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const headerToken = request.headers.get("x-llm-api-key")?.trim();
  return headerToken && headerToken.length > 0 ? headerToken : null;
};

const tokensMatch = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/**
 * Gate for the LLM / upsell customer routes that can trigger paid Bedrock /
 * Qvac inference. Returns `null` when the request is allowed, or an error
 * Response when it is rejected.
 *
 * - When `BFF_LLM_API_KEY` is unset the routes are disabled (403) so a public
 *   demo without explicit gating cannot generate vendor cost.
 * - When set, callers must present it as `Authorization: Bearer <key>` (or the
 *   `x-llm-api-key` header); missing or wrong keys get 401.
 * - Quotas: a fixed-window counter per API key, bounded by
 *   `BFF_LLM_QUOTA_MAX` requests per `BFF_LLM_QUOTA_WINDOW_MS` (429).
 */
export const createLlmGate = (options: LlmGateOptions = {}) => {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const windows = new Map<string, { windowStart: number; count: number }>();

  return (request: Request): Response | null => {
    const expected = env.BFF_LLM_API_KEY?.trim();
    if (!expected) {
      return forbidden("LLM routes are disabled (set BFF_LLM_API_KEY to enable).");
    }

    const provided = extractApiKey(request);
    if (!provided || !tokensMatch(provided, expected)) {
      return unauthorized("Invalid LLM API key.");
    }

    const quotaMax = parsePositiveInt(env.BFF_LLM_QUOTA_MAX, DEFAULT_LLM_QUOTA_MAX);
    const windowMs = parsePositiveInt(env.BFF_LLM_QUOTA_WINDOW_MS, DEFAULT_LLM_QUOTA_WINDOW_MS);
    const ts = now();
    const window = windows.get(provided);
    if (!window || ts - window.windowStart >= windowMs) {
      windows.set(provided, { windowStart: ts, count: 1 });
      return null;
    }
    if (window.count >= quotaMax) {
      return rateLimited("LLM request quota exceeded.");
    }
    window.count += 1;
    return null;
  };
};
