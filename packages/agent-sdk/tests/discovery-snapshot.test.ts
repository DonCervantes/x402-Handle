import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  DISCOVERY_SNAPSHOT_MAX_AGE_MS,
  type DiscoverySnapshotHeader,
  canonicalJson,
  discoverySnapshotSigningInput,
} from "contracts";
import {
  DiscoverySnapshotError,
  type DiscoverySnapshotErrorCode,
  verifyDiscoverySnapshot,
} from "../src/index";

// Minimal independent signer (same wire format as the BFF) so these tests do
// not depend on the BFF app; apps/bff/tests covers the BFF -> SDK round trip.
const makeKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    privateKey,
    publicKey: raw.toString("base64url"),
    keyId: createHash("sha256").update(raw).digest("base64url").slice(0, 16),
  };
};

const key = makeKey();
const NOW = new Date("2026-10-20T12:00:00.000Z");
const data = { cdp: [{ resource: "https://svc.test/a" }], dexter: [], payai: [] };

const signed = (
  overrides: Partial<DiscoverySnapshotHeader> = {},
  payload: unknown = data,
  signer = key,
) => {
  const header: DiscoverySnapshotHeader = {
    version: 1,
    alg: "Ed25519",
    keyId: signer.keyId,
    source: "live",
    generatedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    staleFacilitators: [],
    digest: `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("base64url")}`,
    ...overrides,
  };
  const signature = sign(
    null,
    Buffer.from(discoverySnapshotSigningInput(header)),
    signer.privateKey,
  ).toString("base64url");
  return { ...header, data: payload, signature };
};

const expectCode = (fn: () => unknown, code: DiscoverySnapshotErrorCode) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DiscoverySnapshotError);
    expect((error as DiscoverySnapshotError).code).toBe(code);
    return;
  }
  throw new Error(`expected DiscoverySnapshotError(${code})`);
};

describe("verifyDiscoverySnapshot", () => {
  test("accepts a valid snapshot and reports its age and source", () => {
    const result = verifyDiscoverySnapshot(signed(), { publicKey: key.publicKey, now: NOW });
    expect(result.source).toBe("live");
    expect(result.ageMs).toBe(60 * 60 * 1000);
    expect(result.data).toEqual(data);
  });

  test("survives a JSON round trip (what an agent receives over HTTP)", () => {
    const wire = JSON.parse(JSON.stringify(signed()));
    expect(verifyDiscoverySnapshot(wire, { publicKey: key.publicKey, now: NOW }).source).toBe(
      "live",
    );
  });

  test("rejects a snapshot older than the documented max age", () => {
    const old = signed({
      generatedAt: new Date(NOW.getTime() - DISCOVERY_SNAPSHOT_MAX_AGE_MS - 1).toISOString(),
    });
    expectCode(
      () => verifyDiscoverySnapshot(old, { publicKey: key.publicKey, now: NOW }),
      "expired",
    );
  });

  test("accepts exactly the max age and honours a custom maxAgeMs", () => {
    const edge = signed({
      generatedAt: new Date(NOW.getTime() - DISCOVERY_SNAPSHOT_MAX_AGE_MS).toISOString(),
    });
    expect(verifyDiscoverySnapshot(edge, { publicKey: key.publicKey, now: NOW }).source).toBe(
      "live",
    );
    expectCode(
      () =>
        verifyDiscoverySnapshot(signed(), { publicKey: key.publicKey, now: NOW, maxAgeMs: 1000 }),
      "expired",
    );
  });

  test("rejects a bad signature", () => {
    const snapshot = signed();
    const sig = Buffer.from(snapshot.signature, "base64url");
    sig[0] = (sig[0] ?? 0) ^ 0xff;
    expectCode(
      () =>
        verifyDiscoverySnapshot(
          { ...snapshot, signature: sig.toString("base64url") },
          { publicKey: key.publicKey, now: NOW },
        ),
      "bad_signature",
    );
  });

  test("rejects a tampered header (relabeling a seed as live or making it fresher)", () => {
    const seed = signed({ source: "seed" });
    expectCode(
      () =>
        verifyDiscoverySnapshot(
          { ...seed, source: "live" },
          { publicKey: key.publicKey, now: NOW },
        ),
      "bad_signature",
    );
    const fresher = { ...signed(), generatedAt: NOW.toISOString() };
    expectCode(
      () => verifyDiscoverySnapshot(fresher, { publicKey: key.publicKey, now: NOW }),
      "bad_signature",
    );
  });

  test("rejects tampered data", () => {
    const snapshot = signed();
    expectCode(
      () =>
        verifyDiscoverySnapshot(
          { ...snapshot, data: { ...data, payai: [{ resource: "https://evil.test" }] } },
          { publicKey: key.publicKey, now: NOW },
        ),
      "bad_digest",
    );
  });

  test("rejects a snapshot signed by a different key, even if self-consistent", () => {
    const other = makeKey();
    expectCode(
      () =>
        verifyDiscoverySnapshot(signed({}, data, other), { publicKey: key.publicKey, now: NOW }),
      "unknown_key",
    );
    // Forged keyId pointing at the pinned key but signed with another key.
    expectCode(
      () =>
        verifyDiscoverySnapshot(
          signed({ keyId: key.keyId }, data, { ...other, keyId: key.keyId }),
          {
            publicKey: key.publicKey,
            now: NOW,
          },
        ),
      "bad_signature",
    );
  });

  test("rejects malformed envelopes and invalid public keys", () => {
    expectCode(() => verifyDiscoverySnapshot(null, { publicKey: key.publicKey }), "malformed");
    expectCode(
      () =>
        verifyDiscoverySnapshot({ ...signed(), source: "fixture" }, { publicKey: key.publicKey }),
      "malformed",
    );
    expectCode(
      () => verifyDiscoverySnapshot(signed(), { publicKey: "AAAA", now: NOW }),
      "unknown_key",
    );
  });

  test("rejects a generatedAt in the future beyond the allowed clock skew", () => {
    const future = signed({ generatedAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() });
    expectCode(
      () => verifyDiscoverySnapshot(future, { publicKey: key.publicKey, now: NOW }),
      "not_yet_valid",
    );
  });

  test("can refuse the committed seed", () => {
    const seed = signed({ source: "seed" });
    expect(verifyDiscoverySnapshot(seed, { publicKey: key.publicKey, now: NOW }).source).toBe(
      "seed",
    );
    expectCode(
      () =>
        verifyDiscoverySnapshot(seed, {
          publicKey: key.publicKey,
          now: NOW,
          allowedSources: ["live"],
        }),
      "source_not_allowed",
    );
  });
});
