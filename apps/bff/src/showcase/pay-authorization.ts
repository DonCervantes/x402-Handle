import crypto from "node:crypto";
import { json } from "./flovia-track-paid-api";

// The /pay endpoints hold server-side payer keys. They must never be unlocked
// by a value a browser can hard-code in a request header. Access is denied by
// default and requires an explicit opt-in plus a high-entropy server secret.

export const SHOWCASE_PAY_ENABLED_ENV = "SHOWCASE_PAY_ENABLED";
export const SHOWCASE_PAY_SECRET_ENV = "SHOWCASE_PAY_SECRET";
export const SHOWCASE_PAY_HEADER = "x-flovia-showcase-pay";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const MIN_SECRET_LENGTH = 16;

export type ShowcasePayGateResult =
  | { status: "ready" }
  | { status: "disabled" }
  | { status: "secret_missing"; requiredEnv: string[] }
  | { status: "secret_too_short"; requiredEnv: string[]; minLength: number }
  | { status: "unauthorized" };

const envValue = (env: NodeJS.ProcessEnv, key: string) => env[key]?.trim() ?? "";

export function checkShowcasePayGate(
  env: NodeJS.ProcessEnv = process.env,
): Exclude<ShowcasePayGateResult, { status: "unauthorized" }> {
  if (!ENABLED_VALUES.has(envValue(env, SHOWCASE_PAY_ENABLED_ENV).toLowerCase())) {
    return { status: "disabled" };
  }

  const secret = envValue(env, SHOWCASE_PAY_SECRET_ENV);
  if (!secret) {
    return { status: "secret_missing", requiredEnv: [SHOWCASE_PAY_SECRET_ENV] };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      status: "secret_too_short",
      requiredEnv: [SHOWCASE_PAY_SECRET_ENV],
      minLength: MIN_SECRET_LENGTH,
    };
  }
  return { status: "ready" };
}

/**
 * Constant-time comparison of SHA-256 digests: no early exit on the first
 * differing byte and no length side channel from `timingSafeEqual`.
 */
export function hasValidShowcasePaySecret(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (checkShowcasePayGate(env).status !== "ready") return false;
  const supplied = request.headers.get(SHOWCASE_PAY_HEADER);
  if (supplied === null) return false;

  const expectedDigest = crypto
    .createHash("sha256")
    .update(envValue(env, SHOWCASE_PAY_SECRET_ENV), "utf8")
    .digest();
  const suppliedDigest = crypto.createHash("sha256").update(supplied, "utf8").digest();
  return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

export function authorizeShowcasePay(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): ShowcasePayGateResult {
  const gate = checkShowcasePayGate(env);
  if (gate.status !== "ready") return gate;
  return hasValidShowcasePaySecret(request, env) ? { status: "ready" } : { status: "unauthorized" };
}

/**
 * Builds a denial response. Deliberately never includes the configured secret
 * or the supplied header value in the body or headers.
 */
export function denyShowcasePay(result: ShowcasePayGateResult): Response {
  switch (result.status) {
    case "disabled":
      return json(
        {
          error: "showcase_pay_disabled",
          message:
            "Showcase /pay endpoints are disabled. Set SHOWCASE_PAY_ENABLED=true and SHOWCASE_PAY_SECRET to enable them explicitly.",
          requiredEnv: [SHOWCASE_PAY_ENABLED_ENV, SHOWCASE_PAY_SECRET_ENV],
        },
        { status: 403 },
      );
    case "secret_missing":
      return json(
        {
          error: "showcase_pay_not_configured",
          message: `Set ${SHOWCASE_PAY_SECRET_ENV} to a long random secret before enabling showcase /pay endpoints.`,
          requiredEnv: result.requiredEnv,
        },
        { status: 503 },
      );
    case "secret_too_short":
      return json(
        {
          error: "showcase_pay_not_configured",
          message: `${SHOWCASE_PAY_SECRET_ENV} must be at least ${result.minLength} characters.`,
          requiredEnv: result.requiredEnv,
          minLength: result.minLength,
        },
        { status: 503 },
      );
    case "unauthorized":
      return json(
        {
          error: "showcase_pay_unauthorized",
          message:
            "A valid showcase pay secret is required. The old static confirmation header is not accepted.",
          requiredHeader: SHOWCASE_PAY_HEADER,
        },
        { status: 401 },
      );
    case "ready":
      throw new Error("Cannot deny an authorized showcase pay request.");
  }
}

export function withShowcasePayAuth(
  request: Request,
  handler: (request: Request) => Promise<Response> | Response,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> | Response {
  const result = authorizeShowcasePay(request, env);
  return result.status === "ready" ? handler(request) : denyShowcasePay(result);
}
