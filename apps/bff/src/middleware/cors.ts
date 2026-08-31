/**
 * CORS middleware — enforces explicit origin allowlist for frontend origins only.
 */

type CorsOptions = {
  allowedOrigins: string[];
  allowCredentials?: boolean;
};

const DEFAULT_ALLOWED_METHODS = "GET, POST, OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Content-Type, Authorization, X-Refresh-Token";
const DEFAULT_MAX_AGE = "86400"; // 24 hours

/**
 * Resolve CORS allowed origins from environment or use defaults.
 * Multiple origins are comma-separated.
 */
export const resolveAllowedOrigins = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const origins = env.BFF_CORS_ALLOWED_ORIGINS?.trim();
  if (!origins) {
    // Default to common local development origins
    return ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000"];
  }
  return origins.split(",").map((origin) => origin.trim()).filter(Boolean);
};

/**
 * Create CORS options resolver from environment.
 */
export const createCorsOptions = (env: NodeJS.ProcessEnv = process.env): CorsOptions => ({
  allowedOrigins: resolveAllowedOrigins(env),
  allowCredentials: true,
});

/**
 * Apply CORS headers to a response based on request origin.
 * Returns null if origin is not allowed.
 */
export const applyCorsHeaders = (
  request: Request,
  options: CorsOptions,
): Record<string, string> | null => {
  const origin = request.headers.get("origin");
  
  // If no origin header (e.g., same-origin or non-browser requests), allow through
  if (!origin) {
    return {};
  }

  // Check if origin is in allowlist
  if (!options.allowedOrigins.includes(origin)) {
    return null;
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": DEFAULT_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": DEFAULT_ALLOWED_HEADERS,
    "Access-Control-Max-Age": DEFAULT_MAX_AGE,
  };

  if (options.allowCredentials) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
};

/**
 * Handle CORS preflight (OPTIONS) request.
 * Returns 204 response with CORS headers if origin is allowed, 403 otherwise.
 */
export const handleCorsPreFlight = (request: Request, options: CorsOptions): Response => {
  const corsHeaders = applyCorsHeaders(request, options);
  
  if (corsHeaders === null) {
    return new Response("Origin not allowed", { status: 403 });
  }

  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
};

/**
 * Wrap a response with CORS headers.
 * Returns 403 if origin is not allowed.
 */
export const wrapResponseWithCors = (
  request: Request,
  response: Response,
  options: CorsOptions,
): Response => {
  const corsHeaders = applyCorsHeaders(request, options);
  
  if (corsHeaders === null) {
    return new Response("Origin not allowed", { status: 403 });
  }

  // If no CORS headers needed (same-origin), return original response
  if (Object.keys(corsHeaders).length === 0) {
    return response;
  }

  // Clone response and add CORS headers
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
