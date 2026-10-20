import { describe, expect, test } from "bun:test";
import {
  DISCOVERY_SNAPSHOT_MAX_AGE_MS,
  DiscoverySigningKeySchema,
  SignedDiscoverySnapshotSchema,
  canonicalJson,
  discoverySnapshotSigningInput,
} from "../src/index";

const header = {
  version: 1 as const,
  alg: "Ed25519" as const,
  keyId: "k1",
  source: "live" as const,
  generatedAt: "2026-10-18T12:00:00.000Z",
  staleFacilitators: [],
  digest: "sha256:abc_-",
};

describe("canonicalJson", () => {
  test("sorts object keys at every depth and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  test("is insensitive to key insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  test("encodes undefined array slots as null like JSON.stringify", () => {
    expect(canonicalJson([1, undefined])).toBe("[1,null]");
  });

  test("escapes strings exactly like JSON.stringify", () => {
    const value = { 'k"ey': "a\nb " };
    expect(canonicalJson(value)).toBe(JSON.stringify(value));
  });

  test("rejects a top-level undefined", () => {
    expect(() => canonicalJson(undefined)).toThrow();
  });
});

describe("discoverySnapshotSigningInput", () => {
  test("covers every header field and ignores data and signature", () => {
    const input = discoverySnapshotSigningInput({ ...header });
    expect(JSON.parse(input)).toEqual(header);
    const withExtra = { ...header, data: { big: true }, signature: "sig" };
    expect(discoverySnapshotSigningInput(withExtra)).toBe(input);
  });

  test("changes when any signed field changes", () => {
    const input = discoverySnapshotSigningInput(header);
    expect(discoverySnapshotSigningInput({ ...header, source: "seed" })).not.toBe(input);
    expect(
      discoverySnapshotSigningInput({ ...header, generatedAt: "2026-10-19T12:00:00.000Z" }),
    ).not.toBe(input);
    expect(discoverySnapshotSigningInput({ ...header, staleFacilitators: ["cdp"] })).not.toBe(
      input,
    );
  });
});

describe("schemas", () => {
  test("accepts a well-formed signed snapshot", () => {
    const parsed = SignedDiscoverySnapshotSchema.safeParse({
      ...header,
      data: {},
      signature: "AbC-_",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects unknown sources, extra fields and non-base64url signatures", () => {
    const ok = { ...header, data: {}, signature: "AbC" };
    expect(SignedDiscoverySnapshotSchema.safeParse({ ...ok, source: "fixture" }).success).toBe(
      false,
    );
    expect(SignedDiscoverySnapshotSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(SignedDiscoverySnapshotSchema.safeParse({ ...ok, signature: "a+b/" }).success).toBe(
      false,
    );
    expect(
      SignedDiscoverySnapshotSchema.safeParse({ ...ok, generatedAt: "yesterday" }).success,
    ).toBe(false);
  });

  test("published key document", () => {
    expect(
      DiscoverySigningKeySchema.safeParse({
        alg: "Ed25519",
        keyId: "k1",
        publicKey: "AAAA",
        ephemeral: false,
        maxAgeSeconds: DISCOVERY_SNAPSHOT_MAX_AGE_MS / 1000,
      }).success,
    ).toBe(true);
  });
});
