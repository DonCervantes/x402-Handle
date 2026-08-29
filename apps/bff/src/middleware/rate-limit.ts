/**
 * Rate limiting middleware — per-IP and per-token sliding window rate limits.
 * 
 * Tracks request counts in-memory using a sliding window algorithm.
 * Configurable limits for different endpoint categories (pay, LLM, refresh).
 */

type RateLimitWindow = {
  count: number;
  resetAt: number;
};

type RateLimitConfig = {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
};

type RateLimitStore = Map<string, RateLimitWindow>;

const CLEANUP_INTERVAL_MS = 60_000; // Clean up expired entries every minute

/**
 * Rate limit configurations by category.
 */
export type RateLimitConfigs = {
  /** Payment endpoints (expensive, stateful) */
  pay: RateLimitConfig;
  /** LLM endpoints (computationally expensive) */
  llm: RateLimitConfig;
  /** Discovery refresh endpoint (expensive, stateful) */
  refresh: RateLimitConfig;
};

/**
 * Default rate limit configurations.
 */
export const DEFAULT_RATE_LIMITS: RateLimitConfigs = {
  pay: { maxRequests: 10, windowMs: 60_000 }, // 10 requests per minute
  llm: { maxRequests: 20, windowMs: 60_000 }, // 20 requests per minute
  refresh: { maxRequests: 5, windowMs: 60_000 }, // 5 requests per minute
};

/**
 * Resolve rate limit configurations from environment or use defaults.
 */
export const resolveRateLimitConfigs = (
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfigs => {
  const parseConfig = (prefix: string, defaults: RateLimitConfig): RateLimitConfig => {
    const maxRequests = env[`${prefix}_MAX_REQUESTS`];
    const windowMs = env[`${prefix}_WINDOW_MS`];
    return {
      maxRequests: maxRequests ? Number.parseInt(maxRequests, 10) : defaults.maxRequests,
      windowMs: windowMs ? Number.parseInt(windowMs, 10) : defaults.windowMs,
    };
  };

  return {
    pay: parseConfig("BFF_RATE_LIMIT_PAY", DEFAULT_RATE_LIMITS.pay),
    llm: parseConfig("BFF_RATE_LIMIT_LLM", DEFAULT_RATE_LIMITS.llm),
    refresh: parseConfig("BFF_RATE_LIMIT_REFRESH", DEFAULT_RATE_LIMITS.refresh),
  };
};

/**
 * Rate limiter using sliding window algorithm.
 */
export class RateLimiter {
  private ipStore: RateLimitStore = new Map();
  private tokenStore: RateLimitStore = new Map();
  private cleanupTimer: Timer | null = null;

  constructor(private configs: RateLimitConfigs) {
    this.startCleanup();
  }

  /**
   * Extract client IP from request.
   * Handles X-Forwarded-For, X-Real-IP headers for proxied requests.
   */
  private extractClientIp(request: Request): string {
    // Check forwarded headers (from proxies/load balancers)
    const forwardedFor = request.headers.get("x-forwarded-for");
    if (forwardedFor) {
      const ips = forwardedFor.split(",").map((ip) => ip.trim());
      if (ips[0]) return ips[0];
    }

    const realIp = request.headers.get("x-real-ip");
    if (realIp) return realIp.trim();

    // Fallback to connection remote address (may not be available in all runtimes)
    return "unknown";
  }

  /**
   * Extract refresh token from request for per-token rate limiting.
   */
  private extractRefreshToken(request: Request): string | null {
    const auth = request.headers.get("authorization");
    if (auth?.toLowerCase().startsWith("bearer ")) {
      const token = auth.slice(7).trim();
      if (token) return token;
    }
    const headerToken = request.headers.get("x-refresh-token")?.trim();
    return headerToken && headerToken.length > 0 ? headerToken : null;
  }

  /**
   * Check rate limit for a given key in a store.
   * Returns true if rate limit is exceeded.
   */
  private checkLimit(
    store: RateLimitStore,
    key: string,
    config: RateLimitConfig,
    now: number,
  ): boolean {
    const window = store.get(key);

    // No existing window or expired window — create new
    if (!window || now >= window.resetAt) {
      store.set(key, { count: 1, resetAt: now + config.windowMs });
      return false;
    }

    // Window still active — check if limit exceeded
    if (window.count >= config.maxRequests) {
      return true;
    }

    // Increment count
    window.count++;
    return false;
  }

  /**
   * Check rate limit for a request.
   * Returns null if allowed, or a Response with 429 status if rate limited.
   */
  checkRateLimit(
    request: Request,
    category: keyof RateLimitConfigs,
  ): Response | null {
    const config = this.configs[category];
    const now = Date.now();
    const ip = this.extractClientIp(request);

    // Check IP-based rate limit
    const ipKey = `${category}:ip:${ip}`;
    if (this.checkLimit(this.ipStore, ipKey, config, now)) {
      return this.createRateLimitResponse(config, now, this.ipStore.get(ipKey)!.resetAt);
    }

    // For refresh endpoint, also check per-token rate limit
    if (category === "refresh") {
      const token = this.extractRefreshToken(request);
      if (token) {
        // Use a hash of the token to avoid storing raw tokens
        const tokenKey = `${category}:token:${this.hashToken(token)}`;
        if (this.checkLimit(this.tokenStore, tokenKey, config, now)) {
          return this.createRateLimitResponse(config, now, this.tokenStore.get(tokenKey)!.resetAt);
        }
      }
    }

    return null;
  }

  /**
   * Create a 429 Too Many Requests response.
   */
  private createRateLimitResponse(
    config: RateLimitConfig,
    now: number,
    resetAt: number,
  ): Response {
    const retryAfterSeconds = Math.ceil((resetAt - now) / 1000);
    return new Response(
      JSON.stringify({
        error: "rate_limit_exceeded",
        message: `Rate limit exceeded. Maximum ${config.maxRequests} requests per ${config.windowMs / 1000} seconds.`,
        retryAfter: retryAfterSeconds,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": retryAfterSeconds.toString(),
          "X-RateLimit-Limit": config.maxRequests.toString(),
          "X-RateLimit-Window": (config.windowMs / 1000).toString(),
        },
      },
    );
  }

  /**
   * Simple hash function for token keys (avoid storing raw tokens).
   */
  private hashToken(token: string): string {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      const char = token.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  /**
   * Clean up expired entries from stores.
   */
  private cleanup(): void {
    const now = Date.now();
    
    for (const [key, window] of this.ipStore.entries()) {
      if (now >= window.resetAt) {
        this.ipStore.delete(key);
      }
    }

    for (const [key, window] of this.tokenStore.entries()) {
      if (now >= window.resetAt) {
        this.tokenStore.delete(key);
      }
    }
  }

  /**
   * Start periodic cleanup of expired entries.
   */
  private startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop periodic cleanup (for testing or shutdown).
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get current store sizes (for monitoring/debugging).
   */
  getStoreSizes(): { ipStore: number; tokenStore: number } {
    return {
      ipStore: this.ipStore.size,
      tokenStore: this.tokenStore.size,
    };
  }
}

/**
 * Determine rate limit category for a given path.
 */
export const getRateLimitCategory = (path: string): keyof RateLimitConfigs | null => {
  // Payment endpoints
  if (
    path === "/stellar/playground/pay" ||
    path === "/showcase/stripe-mpp/pay" ||
    path === "/showcase/solana-mpp/pay"
  ) {
    return "pay";
  }

  // LLM endpoints
  if (
    path.includes("/llm/upsell-explanation") ||
    path.includes("/llm/workflow-intent")
  ) {
    return "llm";
  }

  // Refresh endpoint
  if (path === "/aeo/x402/refresh") {
    return "refresh";
  }

  return null;
};
