// Offline verification of signed x402 discovery snapshots served by the BFF
// (GET /aeo/x402/snapshot). Needs only the BFF's published public key
// (GET /aeo/x402/signing-key, pinned by the agent) — never the refresh token.
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  DISCOVERY_SNAPSHOT_CLOCK_SKEW_MS,
  DISCOVERY_SNAPSHOT_MAX_AGE_MS,
  type DiscoverySnapshotSource,
  type SignedDiscoverySnapshot,
  SignedDiscoverySnapshotSchema,
  canonicalJson,
  discoverySnapshotSigningInput,
} from "contracts";

export type DiscoverySnapshotErrorCode =
  | "malformed"
  | "unknown_key"
  | "bad_digest"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "source_not_allowed";

export class DiscoverySnapshotError extends Error {
  readonly code: DiscoverySnapshotErrorCode;

  constructor(code: DiscoverySnapshotErrorCode, message: string) {
    super(message);
    this.name = "DiscoverySnapshotError";
    this.code = code;
  }
}

export type VerifyDiscoverySnapshotOpts = {
  /** base64url raw 32-byte Ed25519 public key (the `publicKey` of /aeo/x402/signing-key). */
  publicKey: string;
  /** Reject snapshots older than this. Defaults to DISCOVERY_SNAPSHOT_MAX_AGE_MS (24h). */
  maxAgeMs?: number;
  /** Sources to accept. Defaults to both; pass ["live"] to refuse the committed seed. */
  allowedSources?: readonly DiscoverySnapshotSource[];
  /** Clock used for the age check (tests / replay). */
  now?: Date;
};

export type VerifiedDiscoverySnapshot<T = unknown> = SignedDiscoverySnapshot<T> & {
  /** Age at verification time, in milliseconds. */
  ageMs: number;
};

// DER prefix of an SPKI Ed25519 public key; the raw 32-byte key follows it.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const publicKeyFromRaw = (publicKey: string) => {
  const raw = Buffer.from(publicKey, "base64url");
  if (raw.length !== 32) {
    throw new DiscoverySnapshotError("unknown_key", "publicKey must be a 32-byte Ed25519 key.");
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
};

const keyIdFor = (publicKey: string): string =>
  createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url").slice(0, 16);

/**
 * Verifies a signed discovery snapshot and returns it with its age.
 * Throws DiscoverySnapshotError (with a `code`) when it must be rejected.
 */
export const verifyDiscoverySnapshot = <T = unknown>(
  envelope: unknown,
  opts: VerifyDiscoverySnapshotOpts,
): VerifiedDiscoverySnapshot<T> => {
  const parsed = SignedDiscoverySnapshotSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new DiscoverySnapshotError(
      "malformed",
      `Invalid discovery snapshot: ${parsed.error.message}`,
    );
  }
  const snapshot = parsed.data as SignedDiscoverySnapshot<T>;

  const key = publicKeyFromRaw(opts.publicKey);
  if (snapshot.keyId !== keyIdFor(opts.publicKey)) {
    throw new DiscoverySnapshotError(
      "unknown_key",
      `Snapshot signed by key ${snapshot.keyId}, which is not the pinned BFF key.`,
    );
  }

  const digest = `sha256:${createHash("sha256").update(canonicalJson(snapshot.data), "utf8").digest("base64url")}`;
  if (digest !== snapshot.digest) {
    throw new DiscoverySnapshotError(
      "bad_digest",
      "Snapshot data does not match its signed digest.",
    );
  }

  const signatureOk = verify(
    null,
    Buffer.from(discoverySnapshotSigningInput(snapshot), "utf8"),
    key,
    Buffer.from(snapshot.signature, "base64url"),
  );
  if (!signatureOk) {
    throw new DiscoverySnapshotError("bad_signature", "Snapshot signature is invalid.");
  }

  const allowed = opts.allowedSources ?? ["seed", "live"];
  if (!allowed.includes(snapshot.source)) {
    throw new DiscoverySnapshotError(
      "source_not_allowed",
      `Snapshot source "${snapshot.source}" is not accepted (allowed: ${allowed.join(", ")}).`,
    );
  }

  const now = (opts.now ?? new Date()).getTime();
  const ageMs = now - Date.parse(snapshot.generatedAt);
  if (ageMs < -DISCOVERY_SNAPSHOT_CLOCK_SKEW_MS) {
    throw new DiscoverySnapshotError("not_yet_valid", "Snapshot generatedAt is in the future.");
  }
  const maxAgeMs = opts.maxAgeMs ?? DISCOVERY_SNAPSHOT_MAX_AGE_MS;
  if (ageMs > maxAgeMs) {
    throw new DiscoverySnapshotError(
      "expired",
      `Snapshot is ${Math.round(ageMs / 60000)} min old (max ${Math.round(maxAgeMs / 60000)} min).`,
    );
  }

  return { ...snapshot, ageMs: Math.max(0, ageMs) };
};
