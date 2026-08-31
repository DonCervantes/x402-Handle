# BFF Security: CORS Allowlist and Rate Limiting

## Overview

This document describes the CORS (Cross-Origin Resource Sharing) and rate limiting implementation added to the BFF (Backend for Frontend) to address security issue #20.

## Problem

The BFF previously had:
- No CORS policy, allowing requests from any origin
- No rate limiting, making expensive endpoints vulnerable to abuse
- Specific concerns around pay, LLM, and refresh endpoints which are:
  - Computationally expensive (LLM)
  - Stateful/mutating (pay, refresh)
  - Abusable by browsers and scripts

## Solution

### 1. CORS Allowlist

**Location**: `apps/bff/src/middleware/cors.ts`

**Features**:
- Explicit origin allowlist (frontend origins only)
- Configurable via environment variable `BFF_CORS_ALLOWED_ORIGINS`
- Defaults to local development origins if not configured
- Handles preflight (OPTIONS) requests
- Wraps all responses with appropriate CORS headers
- Rejects requests from non-allowlisted origins with 403

**Configuration**:
```bash
# .env or environment variables
BFF_CORS_ALLOWED_ORIGINS=https://app.example.com,https://staging.example.com
```

**Defaults** (when not configured):
- `http://localhost:3000`
- `http://localhost:5173`
- `http://127.0.0.1:3000`

### 2. Rate Limiting

**Location**: `apps/bff/src/middleware/rate-limit.ts`

**Features**:
- Per-IP rate limiting using sliding window algorithm
- Per-token rate limiting for refresh endpoint
- Separate limits for three categories:
  - **Pay endpoints**: Payment-related operations
  - **LLM endpoints**: AI/ML expensive operations
  - **Refresh endpoints**: Discovery data refresh
- Configurable limits per category
- Automatic cleanup of expired rate limit windows
- Returns 429 with `Retry-After` header when limit exceeded

**Rate-Limited Endpoints**:

**Pay** (10 req/min default):
- `/stellar/playground/pay`
- `/showcase/stripe-mpp/pay`
- `/showcase/solana-mpp/pay`

**LLM** (20 req/min default):
- `/customers/:address/llm/upsell-explanation`
- `/customers/:address/llm/workflow-intent`

**Refresh** (5 req/min default):
- `/aeo/x402/refresh`

**Configuration**:
```bash
# Payment endpoints
BFF_RATE_LIMIT_PAY_MAX_REQUESTS=10
BFF_RATE_LIMIT_PAY_WINDOW_MS=60000

# LLM endpoints
BFF_RATE_LIMIT_LLM_MAX_REQUESTS=20
BFF_RATE_LIMIT_LLM_WINDOW_MS=60000

# Refresh endpoint
BFF_RATE_LIMIT_REFRESH_MAX_REQUESTS=5
BFF_RATE_LIMIT_REFRESH_WINDOW_MS=60000
```

### 3. Integration

**Location**: `apps/bff/src/http.ts`

The middleware is integrated into the main BFF handler:
1. CORS preflight (OPTIONS) requests are handled first
2. Rate limiting is applied to requests matching sensitive endpoints
3. All responses are wrapped with CORS headers
4. Non-allowlisted origins receive 403 responses

## Testing

**Test files**:
- `apps/bff/tests/cors.test.ts` - CORS middleware tests
- `apps/bff/tests/rate-limit.test.ts` - Rate limiting tests

**Run tests**:
```bash
bun test apps/bff/tests/cors.test.ts
bun test apps/bff/tests/rate-limit.test.ts
```

## Deployment Checklist

### Development
- [ ] Add `BFF_CORS_ALLOWED_ORIGINS` to `.env` (or use defaults)
- [ ] Adjust rate limits if needed for local testing

### Staging
- [ ] Set `BFF_CORS_ALLOWED_ORIGINS` to staging frontend URL
- [ ] Verify rate limits work with staging load

### Production
- [ ] Set `BFF_CORS_ALLOWED_ORIGINS` to production frontend URL(s)
- [ ] Review and adjust rate limits based on expected traffic
- [ ] Monitor rate limit metrics (store sizes available via `RateLimiter.getStoreSizes()`)

## Monitoring

### Rate Limit Headers

When a request is rate-limited, the response includes:
- `X-RateLimit-Limit`: Maximum requests allowed in window
- `X-RateLimit-Window`: Window duration in seconds
- `Retry-After`: Seconds until the window resets

### Metrics

The `RateLimiter` class provides `getStoreSizes()` method to monitor:
- `ipStore`: Number of tracked IP addresses
- `tokenStore`: Number of tracked tokens

## Security Considerations

1. **IP Spoofing**: The rate limiter trusts `X-Forwarded-For` and `X-Real-IP` headers. Ensure these are set by a trusted proxy/load balancer.

2. **Token Hashing**: Refresh tokens are hashed before storing to avoid keeping raw tokens in memory.

3. **Memory Usage**: Rate limit data is stored in-memory and cleaned up automatically. For high-traffic scenarios, consider:
   - Redis-backed rate limiting
   - Separate rate limiter per worker

4. **CORS Wildcard**: The implementation does NOT use wildcard CORS (`*`). Each origin must be explicitly allowlisted.

## Acceptance Criteria

- [x] Explicit CORS allowlist (frontend origins only)
- [x] Per-IP rate limits on pay, LLM, and refresh endpoints
- [x] Per-token rate limits on refresh endpoint
- [x] Configurable via environment variables
- [x] Comprehensive test coverage
- [x] Documentation

## Related

- GitHub Issue: #20
- Audit Commit: 5ae52a2
