// Ed25519 signing for x402 discovery snapshots.
//
// The private key comes from BFF_DISCOVERY_SIGNING_KEY (PKCS#8 PEM, or the
// base64/base64url 32-byte Ed25519 seed). Without it the BFF generates a
// throwaway key at startup and flags it as `ephemeral` on the published key
// document: snapshots still verify, but agents cannot pin a key that changes on
// every restart, so production must configure one.
//
// Only the public key is ever served (GET /aeo/x402/signing-key). Verifying a
// snapshot needs that key and nothing else — not the refresh token.

import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  DISCOVERY_SNAPSHOT_ALG,
  DISCOVERY_SNAPSHOT_MAX_AGE_MS,
  DISCOVERY_SNAPSHOT_VERSION,
  type DiscoverySigningKey,
  type DiscoverySnapshotHeader,
  type DiscoverySnapshotSource,
  type SignedDiscoverySnapshot,
  canonicalJson,
  discoverySnapshotSigningInput,
} from "contracts";

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export type DiscoverySigner = {
  keyId: string;
  ephemeral: boolean;
  publicKeyDocument(): DiscoverySigningKey;
  signSnapshot<T>(input: {
    source: DiscoverySnapshotSource;
    generatedAt: string;
    staleFacilitators?: string[];
    data: T;
  }): SignedDiscoverySnapshot<T>;
};

const base64Url = (bytes: Buffer): string => bytes.toString("base64url");

export const discoverySnapshotDigest = (data: unknown): string =>
  `sha256:${base64Url(createHash("sha256").update(canonicalJson(data), "utf8").digest())}`;

const rawPublicKey = (publicKey: KeyObject): Buffer => {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("Discovery signing key must be an Ed25519 key.");
  }
  return Buffer.from(jwk.x, "base64url");
};

/** Parses BFF_DISCOVERY_SIGNING_KEY: PKCS#8 PEM or a base64/base64url 32-byte seed. */
export const parseDiscoverySigningKey = (value: string): KeyObject => {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    const key = createPrivateKey(trimmed.replace(/\\n/g, "\n"));
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("BFF_DISCOVERY_SIGNING_KEY must be an Ed25519 private key.");
    }
    return key;
  }
  const seed = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (seed.length !== 32) {
    throw new Error(
      "BFF_DISCOVERY_SIGNING_KEY must be a PKCS#8 PEM or a base64 32-byte Ed25519 seed.",
    );
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
};

export const createDiscoverySigner = (
  privateKey: KeyObject,
  options: { ephemeral?: boolean; maxAgeMs?: number } = {},
): DiscoverySigner => {
  const publicKey = rawPublicKey(createPublicKey(privateKey));
  // Short, stable identifier derived from the public key.
  const keyId = base64Url(createHash("sha256").update(publicKey).digest()).slice(0, 16);
  const ephemeral = options.ephemeral ?? false;
  const maxAgeSeconds = Math.floor((options.maxAgeMs ?? DISCOVERY_SNAPSHOT_MAX_AGE_MS) / 1000);

  return {
    keyId,
    ephemeral,
    publicKeyDocument: () => ({
      alg: DISCOVERY_SNAPSHOT_ALG,
      keyId,
      publicKey: base64Url(publicKey),
      ephemeral,
      maxAgeSeconds,
    }),
    signSnapshot: ({ source, generatedAt, staleFacilitators = [], data }) => {
      const header: DiscoverySnapshotHeader = {
        version: DISCOVERY_SNAPSHOT_VERSION,
        alg: DISCOVERY_SNAPSHOT_ALG,
        keyId,
        source,
        generatedAt,
        staleFacilitators: [...staleFacilitators].sort(),
        digest: discoverySnapshotDigest(data),
      };
      const signature = sign(
        null,
        Buffer.from(discoverySnapshotSigningInput(header), "utf8"),
        privateKey,
      );
      return { ...header, data, signature: base64Url(signature) };
    },
  };
};

/** Signer from the environment, or an ephemeral one (with a warning) when unset. */
export const resolveDiscoverySigner = (env: NodeJS.ProcessEnv = process.env): DiscoverySigner => {
  const configured = env.BFF_DISCOVERY_SIGNING_KEY?.trim();
  if (configured) return createDiscoverySigner(parseDiscoverySigningKey(configured));
  console.warn(
    "BFF_DISCOVERY_SIGNING_KEY is not set: signing x402 discovery snapshots with an ephemeral key " +
      "(agents cannot pin it across restarts).",
  );
  return createDiscoverySigner(generateKeyPairSync("ed25519").privateKey, { ephemeral: true });
};
