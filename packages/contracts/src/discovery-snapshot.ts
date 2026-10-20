import { z } from "zod";

// Signed x402 discovery snapshot contract.
//
// The BFF serves its discovery catalog wrapped in an envelope that says where
// the data came from (the committed seed or a live facilitator refresh), when
// it was generated, and an Ed25519 signature from the BFF's published key.
// Agents verify the envelope offline with only the public key: the refresh
// token is never involved.
//
// Signing input = canonicalJson(header) where header is every envelope field
// except `data` and `signature`; `digest` (sha256 of canonicalJson(data))
// binds the data to the header. Hashing/signing need a crypto runtime, so they
// live in the BFF (signer) and the agent SDK (verifier); this module stays
// dependency-free so the frontend can import contracts.

export const DISCOVERY_SNAPSHOT_VERSION = 1 as const;
export const DISCOVERY_SNAPSHOT_ALG = "Ed25519" as const;

/**
 * Documented max age agents accept by default. The production cron refreshes
 * the catalog twice a day, so 24h tolerates one missed run before agents
 * start rejecting the snapshot as stale.
 */
export const DISCOVERY_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Allowed clock skew for a `generatedAt` slightly in the future. */
export const DISCOVERY_SNAPSHOT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const DiscoverySnapshotSourceSchema = z.enum(["seed", "live"]);
export type DiscoverySnapshotSource = z.infer<typeof DiscoverySnapshotSourceSchema>;

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, "expected base64url");

export const DiscoverySnapshotHeaderSchema = z
  .object({
    version: z.literal(DISCOVERY_SNAPSHOT_VERSION),
    alg: z.literal(DISCOVERY_SNAPSHOT_ALG),
    keyId: z.string().min(1),
    source: DiscoverySnapshotSourceSchema,
    generatedAt: z.string().datetime(),
    /** Facilitators whose data was kept from an older snapshot because the last refresh failed for them. */
    staleFacilitators: z.array(z.string()),
    /** `sha256:` + base64url(sha256(canonicalJson(data))). */
    digest: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
  })
  .strict();

export type DiscoverySnapshotHeader = z.infer<typeof DiscoverySnapshotHeaderSchema>;

export const SignedDiscoverySnapshotSchema = DiscoverySnapshotHeaderSchema.extend({
  data: z.unknown(),
  /** base64url Ed25519 signature over `discoverySnapshotSigningInput(header)`. */
  signature: base64Url,
}).strict();

export type SignedDiscoverySnapshot<T = unknown> = DiscoverySnapshotHeader & {
  data: T;
  signature: string;
};

/** Published verification key (`GET /aeo/x402/signing-key`). */
export const DiscoverySigningKeySchema = z
  .object({
    alg: z.literal(DISCOVERY_SNAPSHOT_ALG),
    keyId: z.string().min(1),
    /** base64url of the raw 32-byte Ed25519 public key. */
    publicKey: base64Url,
    /** True when the BFF generated a throwaway key because none was configured. */
    ephemeral: z.boolean(),
    maxAgeSeconds: z.number().int().positive(),
  })
  .strict();

export type DiscoverySigningKey = z.infer<typeof DiscoverySigningKeySchema>;

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped (as
 * JSON.stringify does), no whitespace. Signer and verifier must both use it.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    // JSON.stringify(undefined) is undefined; top-level undefined is not JSON.
    if (encoded === undefined) throw new TypeError("canonicalJson: value is not JSON-serializable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined && typeof item !== "function")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
};

/** Header fields (everything but `data`/`signature`) in a fixed shape. */
export const discoverySnapshotHeader = (
  envelope: DiscoverySnapshotHeader,
): DiscoverySnapshotHeader => ({
  version: envelope.version,
  alg: envelope.alg,
  keyId: envelope.keyId,
  source: envelope.source,
  generatedAt: envelope.generatedAt,
  staleFacilitators: envelope.staleFacilitators,
  digest: envelope.digest,
});

/** Exact string whose UTF-8 bytes are signed. */
export const discoverySnapshotSigningInput = (envelope: DiscoverySnapshotHeader): string =>
  canonicalJson(discoverySnapshotHeader(envelope));
