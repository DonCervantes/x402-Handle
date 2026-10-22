// Security controls for the /stellar/playground/pay endpoint to prevent abuse
// of the demo agent wallet (DEMO_AGENT_SECRET).

/**
 * Configuration for playground security controls.
 */
export type PlaygroundSecurityConfig = {
  /** If false, the playground pay endpoint is completely disabled. */
  enabled: boolean;
  /** Optional API key required to access the endpoint. */
  apiKey: string | null;
  /** Maximum requests per IP address per day. */
  maxRequestsPerIpPerDay: number;
  /** Maximum requests per IP address per hour. */
  maxRequestsPerIpPerHour: number;
};

/**
 * Rate limit tracking per IP address.
 */
type RateLimitEntry = {
  hourlyCount: number;
  hourlyResetAt: number;
  dailyCount: number;
  dailyResetAt: number;
};

/**
 * In-memory rate limiter for playground requests.
 * In production, this should be backed by Redis or a similar distributed store.
 */
export class PlaygroundRateLimiter {
  private limits = new Map<string, RateLimitEntry>();
  private readonly config: PlaygroundSecurityConfig;

  constructor(config: PlaygroundSecurityConfig) {
    this.config = config;
    // Clean up expired entries every hour
    setInterval(() => this.cleanup(), 60 * 60 * 1000);
  }

  /**
   * Check if an IP address has exceeded rate limits.
   * Returns null if allowed, or an error message if rate limited.
   */
  checkRateLimit(ip: string): string | null {
    const now = Date.now();
    const entry = this.limits.get(ip) ?? this.createEntry(now);

    // Reset counters if windows have expired
    if (now >= entry.hourlyResetAt) {
      entry.hourlyCount = 0;
      entry.hourlyResetAt = now + 60 * 60 * 1000; // 1 hour
    }
    if (now >= entry.dailyResetAt) {
      entry.dailyCount = 0;
      entry.dailyResetAt = now + 24 * 60 * 60 * 1000; // 24 hours
    }

    // Check limits
    if (entry.hourlyCount >= this.config.maxRequestsPerIpPerHour) {
      const resetIn = Math.ceil((entry.hourlyResetAt - now) / 1000 / 60);
      return `Rate limit exceeded: maximum ${this.config.maxRequestsPerIpPerHour} requests per hour. Try again in ${resetIn} minutes.`;
    }
    if (entry.dailyCount >= this.config.maxRequestsPerIpPerDay) {
      const resetIn = Math.ceil((entry.dailyResetAt - now) / 1000 / 60 / 60);
      return `Rate limit exceeded: maximum ${this.config.maxRequestsPerIpPerDay} requests per day. Try again in ${resetIn} hours.`;
    }

    // Increment counters
    entry.hourlyCount++;
    entry.dailyCount++;
    this.limits.set(ip, entry);

    return null;
  }

  /**
   * Get current usage for an IP address (for debugging/monitoring).
   */
  getUsage(ip: string): { hourly: number; daily: number } | null {
    const entry = this.limits.get(ip);
    if (!entry) return null;
    return { hourly: entry.hourlyCount, daily: entry.dailyCount };
  }

  private createEntry(now: number): RateLimitEntry {
    return {
      hourlyCount: 0,
      hourlyResetAt: now + 60 * 60 * 1000,
      dailyCount: 0,
      dailyResetAt: now + 24 * 60 * 60 * 1000,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.limits.entries()) {
      // Remove entries that have expired both windows
      if (now >= entry.hourlyResetAt && now >= entry.dailyResetAt) {
        this.limits.delete(ip);
      }
    }
  }
}

/**
 * Extract client IP address from request, considering common proxy headers.
 */
export function extractClientIp(request: Request): string {
  // Check common proxy headers in order of precedence
  const xForwardedFor = request.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    // X-Forwarded-For can contain multiple IPs; take the first (client)
    const firstIp = xForwardedFor.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }

  const xRealIp = request.headers.get("x-real-ip");
  if (xRealIp) return xRealIp.trim();

  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  if (cfConnectingIp) return cfConnectingIp.trim();

  // Fallback to a placeholder if no IP can be determined
  // (shouldn't happen in production, but prevents crashes)
  return "unknown";
}

/**
 * Resolve playground security configuration from environment variables.
 */
export function resolvePlaygroundSecurityConfig(): PlaygroundSecurityConfig {
  const enabled = process.env.BFF_STELLAR_PLAYGROUND_ENABLED?.toLowerCase() === "true";
  const apiKey = process.env.BFF_STELLAR_PLAYGROUND_API_KEY?.trim() || null;

  const maxPerHour = Number(process.env.BFF_PLAYGROUND_MAX_REQUESTS_PER_HOUR);
  const maxPerDay = Number(process.env.BFF_PLAYGROUND_MAX_REQUESTS_PER_DAY);

  return {
    enabled,
    apiKey,
    maxRequestsPerIpPerHour: Number.isFinite(maxPerHour) && maxPerHour > 0 ? maxPerHour : 10,
    maxRequestsPerIpPerDay: Number.isFinite(maxPerDay) && maxPerDay > 0 ? maxPerDay : 50,
  };
}

/**
 * Validate API key from request.
 * Returns true if valid or no key is required, false otherwise.
 */
export function validatePlaygroundApiKey(request: Request, expectedKey: string | null): boolean {
  // If no API key is configured, allow the request
  if (!expectedKey) return true;

  // Check Authorization header (Bearer token)
  const authHeader = request.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token === expectedKey) return true;
  }

  // Check X-API-Key header
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader?.trim() === expectedKey) return true;

  return false;
}
