import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { forbidden, json, unauthorized } from "../http/responses";

const DEFAULT_MAX_REQUESTS_PER_DAY = 10;

type PlaygroundRateLimiter = (ip: string, limit: number, now?: Date) => number | null;

export const createPlaygroundRateLimiter = (): PlaygroundRateLimiter => {
  let currentDay = "";
  const requestsByIp = new Map<string, number>();

  return (ip, limit, now = new Date()) => {
    const day = now.toISOString().slice(0, 10);
    if (day !== currentDay) {
      requestsByIp.clear();
      currentDay = day;
    }

    const requests = requestsByIp.get(ip) ?? 0;
    if (requests >= limit) {
      const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      return Math.ceil((nextDay - now.getTime()) / 1000);
    }

    requestsByIp.set(ip, requests + 1);
    return null;
  };
};

const matchesApiKey = (provided: string, expected: string) => {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return (
    providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
  );
};

const clientIp = (request: Request, remoteAddress?: string) => {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const addresses = forwardedFor.split(",").map((address) => address.trim());
    const lastAddress = addresses[addresses.length - 1];
    if (lastAddress && isIP(lastAddress)) return lastAddress;
  }
  return remoteAddress?.trim() || "unknown";
};

export const checkPlaygroundPaymentSecurity = (
  request: Request,
  remoteAddress: string | undefined,
  rateLimit: PlaygroundRateLimiter,
): Response | null => {
  if (process.env.BFF_STELLAR_PLAYGROUND_ENABLED?.trim().toLowerCase() !== "true") {
    return forbidden("Stellar playground payments are disabled.");
  }

  const expectedApiKey = process.env.BFF_STELLAR_PLAYGROUND_API_KEY?.trim();
  if (!expectedApiKey) {
    return json(
      { error: "misconfigured", message: "BFF_STELLAR_PLAYGROUND_API_KEY is not configured." },
      { status: 503 },
    );
  }

  if (!process.env.DEMO_AGENT_SECRET?.trim()) {
    return json(
      { error: "misconfigured", message: "DEMO_AGENT_SECRET is not configured." },
      { status: 503 },
    );
  }

  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  const providedApiKey =
    bearerMatch?.[1]?.trim() ?? request.headers.get("x-api-key")?.trim() ?? "";
  if (!providedApiKey || !matchesApiKey(providedApiKey, expectedApiKey)) {
    return unauthorized("Missing or invalid Stellar playground API key.");
  }

  const configuredLimit = process.env.BFF_PLAYGROUND_MAX_REQUESTS_PER_DAY?.trim();
  const dailyLimit = configuredLimit ? Number(configuredLimit) : DEFAULT_MAX_REQUESTS_PER_DAY;
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) {
    return json(
      { error: "misconfigured", message: "BFF_PLAYGROUND_MAX_REQUESTS_PER_DAY must be positive." },
      { status: 503 },
    );
  }

  const retryAfter = rateLimit(clientIp(request, remoteAddress), dailyLimit);
  if (retryAfter !== null) {
    return json(
      {
        error: "rate_limited",
        message: "Daily Stellar playground payment limit reached.",
        retryAfter,
      },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    );
  }

  return null;
};
