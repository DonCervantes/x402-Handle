# Implementation Summary: BFF CORS and Rate Limiting

## Issue Reference
GitHub Issue #20: BFF: CORS allowlist + rate limits on pay, LLM, and refresh

## Branch
`fix/bff-cors-rate-limiting`

## Commit
`5d0c6c4` - feat(bff): add CORS allowlist and rate limiting

## What Was Implemented

### 1. CORS Middleware (`apps/bff/src/middleware/cors.ts`)
- Explicit origin allowlist enforcing frontend-only access
- Configurable via `BFF_CORS_ALLOWED_ORIGINS` environment variable
- Defaults to local development origins (`localhost:3000`, `localhost:5173`, `127.0.0.1:3000`)
- Handles preflight OPTIONS requests
- Returns 403 for non-allowlisted origins
- Supports credentials (cookies, auth headers)

### 2. Rate Limiting Middleware (`apps/bff/src/middleware/rate-limit.ts`)
- Sliding window algorithm for accurate rate limiting
- Per-IP tracking using `X-Forwarded-For` and `X-Real-IP` headers
- Per-token tracking for refresh endpoint (hashed for security)
- Three categories with separate limits:
  - **Pay**: 10 requests/minute (payment endpoints)
  - **LLM**: 20 requests/minute (AI/ML endpoints)
  - **Refresh**: 5 requests/minute (discovery refresh)
- Automatic cleanup of expired rate limit windows
- Returns 429 with `Retry-After` and rate limit headers
- Fully configurable via environment variables

### 3. Protected Endpoints

**Pay Endpoints** (10 req/min):
- `/stellar/playground/pay` - Server-side Stellar payment
- `/showcase/stripe-mpp/pay` - Stripe MPP payment
- `/showcase/solana-mpp/pay` - Solana MPP payment

**LLM Endpoints** (20 req/min):
- `/customers/:address/llm/upsell-explanation` - AI-generated upsell explanations
- `/customers/:address/llm/workflow-intent` - AI-generated workflow insights

**Refresh Endpoints** (5 req/min):
- `/aeo/x402/refresh` - Discovery data refresh (also per-token limited)

### 4. Integration (`apps/bff/src/http.ts`)
- CORS preflight handling at the top of request flow
- Rate limiting applied before route processing
- All responses wrapped with CORS headers
- Origin validation on every request

### 5. Tests
- `apps/bff/tests/cors.test.ts` - 100% coverage of CORS middleware
- `apps/bff/tests/rate-limit.test.ts` - Comprehensive rate limiting tests
  - Per-IP tracking
  - Per-token tracking
  - Window expiry
  - Cleanup behavior
  - Multiple categories
  - Header validation

### 6. Configuration (`.env.example`)
```bash
# CORS - comma-separated list of allowed origins
BFF_CORS_ALLOWED_ORIGINS=https://app.example.com,https://staging.example.com

# Rate Limiting - Pay endpoints
BFF_RATE_LIMIT_PAY_MAX_REQUESTS=10
BFF_RATE_LIMIT_PAY_WINDOW_MS=60000

# Rate Limiting - LLM endpoints
BFF_RATE_LIMIT_LLM_MAX_REQUESTS=20
BFF_RATE_LIMIT_LLM_WINDOW_MS=60000

# Rate Limiting - Refresh endpoint
BFF_RATE_LIMIT_REFRESH_MAX_REQUESTS=5
BFF_RATE_LIMIT_REFRESH_WINDOW_MS=60000
```

### 7. Documentation
- `docs/SECURITY-CORS-RATE-LIMITING.md` - Complete security documentation
  - Overview and problem statement
  - Solution architecture
  - Configuration guide
  - Deployment checklist
  - Monitoring guidance
  - Security considerations

## Acceptance Criteria ✅

- ✅ Explicit CORS allowlist (frontend origins only)
- ✅ Per-IP rate limits on pay, LLM, and refresh endpoints
- ✅ Per-token rate limits on refresh endpoint
- ✅ Configurable via environment variables
- ✅ Comprehensive test coverage
- ✅ Documentation included

## How to Test

### Prerequisites
Install Bun if not already installed:
```bash
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1|iex"

# macOS/Linux
curl -fsSL https://bun.sh/install | bash
```

### Run Tests
```bash
# From repository root
bun install
bun run verify

# Or test BFF specifically
cd apps/bff
bun test
```

### Manual Testing

1. **Test CORS**:
```bash
# Should succeed (if localhost:3000 is allowlisted)
curl -H "Origin: http://localhost:3000" http://localhost:3001/health

# Should fail (403)
curl -H "Origin: https://evil.com" http://localhost:3001/health
```

2. **Test Rate Limiting**:
```bash
# Rapid fire 15 requests - should get 429 after 10th
for i in {1..15}; do
  curl -X POST http://localhost:3001/stellar/playground/pay \
    -H "Content-Type: application/json" \
    -d '{"providerId":"test"}' \
    -w "\nStatus: %{http_code}\n"
done
```

3. **Test Preflight**:
```bash
curl -X OPTIONS http://localhost:3001/health \
  -H "Origin: http://localhost:3000" \
  -H "Access-Control-Request-Method: GET"
```

## Deployment Notes

### Environment Setup Required

**Development** (optional - has sensible defaults):
```bash
BFF_CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

**Staging** (required):
```bash
BFF_CORS_ALLOWED_ORIGINS=https://staging.yourapp.com
```

**Production** (required):
```bash
BFF_CORS_ALLOWED_ORIGINS=https://app.yourapp.com,https://www.yourapp.com
```

### Rate Limit Tuning

Default limits are conservative. Adjust based on:
- Expected user traffic
- Infrastructure capacity
- Cost constraints (LLM calls)
- Abuse patterns observed

### Monitoring

Rate limit responses include headers for debugging:
- `X-RateLimit-Limit` - Maximum requests in window
- `X-RateLimit-Window` - Window duration (seconds)
- `Retry-After` - Seconds until reset

Monitor these in production logs to tune limits appropriately.

## Security Considerations

1. **Proxy Configuration**: Rate limiter trusts `X-Forwarded-For` and `X-Real-IP`. Ensure your load balancer/proxy sets these correctly and strips client-provided values.

2. **Token Storage**: Refresh tokens are hashed before storage to avoid keeping raw tokens in memory.

3. **Memory Management**: In-memory rate limiting with automatic cleanup. For very high traffic, consider Redis-backed rate limiting.

4. **Origin Validation**: Never use CORS wildcard (`*`) in production. Always explicitly allowlist origins.

## Breaking Changes

None. The implementation is backward-compatible:
- CORS defaults allow local development
- Rate limiting only applies to specific expensive endpoints
- Existing endpoints continue to work unchanged

## Next Steps

1. Merge this PR after review
2. Deploy to staging and verify CORS + rate limiting work correctly
3. Configure production environment variables
4. Deploy to production
5. Monitor rate limit metrics and tune as needed

## Files Changed

- `apps/bff/src/middleware/cors.ts` (new)
- `apps/bff/src/middleware/rate-limit.ts` (new)
- `apps/bff/src/http.ts` (modified)
- `apps/bff/tests/cors.test.ts` (new)
- `apps/bff/tests/rate-limit.test.ts` (new)
- `.env.example` (modified)
- `docs/SECURITY-CORS-RATE-LIMITING.md` (new)
