import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DISCOVERY_SNAPSHOT_MAX_AGE_MS,
  DiscoverySigningKeySchema,
  SignedDiscoverySnapshotSchema,
  discoverySnapshotSigningInput,
} from "contracts";
import { createBffHandler } from "../src/http";
import {
  createDiscoverySigner,
  discoverySnapshotDigest,
  parseDiscoverySigningKey,
  resolveDiscoverySigner,
} from "../src/data/x402-discovery/signing";
import {
  X402_DISCOVERY_META_FILE,
  createX402DiscoveryStore,
} from "../src/data/x402-discovery/store";

// Independent offline check with only the published public key, using the
// shared contract (same steps as @flovia/agent-sdk's verifyDiscoverySnapshot,
// which has its own tests; the BFF does not depend on the SDK package).
class DiscoverySnapshotError extends Error {}
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const verifyDiscoverySnapshot = (envelope: unknown, opts: { publicKey: string; now: Date }) => {
  const snapshot = SignedDiscoverySnapshotSchema.parse(envelope);
  if (discoverySnapshotDigest(snapshot.data) !== snapshot.digest) {
    throw new DiscoverySnapshotError("bad_digest");
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(opts.publicKey, "base64url")]),
    format: "der",
    type: "spki",
  });
  const ok = verify(
    null,
    Buffer.from(discoverySnapshotSigningInput(snapshot)),
    key,
    Buffer.from(snapshot.signature, "base64url"),
  );
  if (!ok) throw new DiscoverySnapshotError("bad_signature");
  if (opts.now.getTime() - Date.parse(snapshot.generatedAt) > DISCOVERY_SNAPSHOT_MAX_AGE_MS) {
    throw new DiscoverySnapshotError("expired");
  }
  return snapshot;
};

const SEED_GENERATED_AT = "2026-10-20T00:00:00.000Z";
const item = (host: string) => ({ resource: `https://${host}/api/a`, description: "Example" });

const tmpDirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-signed-"));
  tmpDirs.push(dir);
  return dir;
};

const seedDir = (meta?: unknown): string => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "cdp.json"), JSON.stringify([item("svc.test")]));
  fs.writeFileSync(path.join(dir, "dexter.json"), JSON.stringify([]));
  fs.writeFileSync(path.join(dir, "payai.json"), JSON.stringify([]));
  if (meta !== undefined) {
    fs.writeFileSync(path.join(dir, X402_DISCOVERY_META_FILE), JSON.stringify(meta));
  }
  return dir;
};

const okFetch =
  (fetchedAt: string, errors: Record<string, string> = {}) =>
  async () => ({
    cdp: errors.cdp ? [] : [item("live.test")],
    dexter: [],
    payai: [],
    fetchedAt,
    errors,
  });

const signer = createDiscoverySigner(generateKeyPairSync("ed25519").privateKey);
const tokenBackup = process.env.BFF_X402_REFRESH_TOKEN;

beforeEach(() => {
  delete process.env.BFF_X402_REFRESH_TOKEN;
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (tokenBackup === undefined) delete process.env.BFF_X402_REFRESH_TOKEN;
  else process.env.BFF_X402_REFRESH_TOKEN = tokenBackup;
});

describe("discovery signing key", () => {
  test("parses a base64 / base64url 32-byte seed and a PKCS#8 PEM to the same key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    const seed = der.subarray(der.length - 32);
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    const ids = [
      createDiscoverySigner(parseDiscoverySigningKey(seed.toString("base64"))).keyId,
      createDiscoverySigner(parseDiscoverySigningKey(seed.toString("base64url"))).keyId,
      createDiscoverySigner(parseDiscoverySigningKey(pem)).keyId,
      // PEM pasted into a single-line env var with literal \n separators.
      createDiscoverySigner(parseDiscoverySigningKey(pem.replace(/\n/g, "\\n"))).keyId,
    ];
    expect(new Set(ids).size).toBe(1);
  });

  test("rejects seeds of the wrong length and non-Ed25519 keys", () => {
    expect(() => parseDiscoverySigningKey(Buffer.alloc(16).toString("base64"))).toThrow();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    expect(() => parseDiscoverySigningKey(rsa)).toThrow();
  });

  test("falls back to a flagged ephemeral key when none is configured", () => {
    const ephemeral = resolveDiscoverySigner({});
    expect(ephemeral.ephemeral).toBe(true);
    const seed = Buffer.alloc(32, 7).toString("base64");
    const configured = resolveDiscoverySigner({ BFF_DISCOVERY_SIGNING_KEY: seed });
    expect(configured.ephemeral).toBe(false);
    expect(resolveDiscoverySigner({ BFF_DISCOVERY_SIGNING_KEY: seed }).keyId).toBe(
      configured.keyId,
    );
  });

  test("the published key document carries only public material", () => {
    const doc = signer.publicKeyDocument();
    expect(DiscoverySigningKeySchema.safeParse(doc).success).toBe(true);
    expect(Object.keys(doc).sort()).toEqual([
      "alg",
      "ephemeral",
      "keyId",
      "maxAgeSeconds",
      "publicKey",
    ]);
    expect(doc.maxAgeSeconds).toBe(DISCOVERY_SNAPSHOT_MAX_AGE_MS / 1000);
  });
});

describe("discovery store provenance", () => {
  test("committed seed keeps its recorded capture time instead of the load time", () => {
    const store = createX402DiscoveryStore({
      dir: seedDir({ source: "seed", generatedAt: SEED_GENERATED_AT }),
    });
    store.loadInitial();
    const snapshot = store.snapshot();
    expect(snapshot?.source).toBe("seed");
    expect(snapshot?.generatedAt).toBe(SEED_GENERATED_AT);
  });

  test("a seed without provenance is labeled seed with an unknown (epoch) age", () => {
    const store = createX402DiscoveryStore({ dir: seedDir() });
    store.loadInitial();
    expect(store.snapshot()?.source).toBe("seed");
    expect(store.snapshot()?.generatedAt).toBe(new Date(0).toISOString());
  });

  test("no data loaded -> no snapshot", () => {
    const store = createX402DiscoveryStore({ dir: tempDir() });
    store.loadInitial();
    expect(store.snapshot()).toBeNull();
  });

  test("a live refresh is labeled live and survives a restart", async () => {
    const dir = seedDir({ source: "seed", generatedAt: SEED_GENERATED_AT });
    const dataDir = tempDir();
    const fetchedAt = "2026-10-20T06:00:00.000Z";
    const store = createX402DiscoveryStore({ dir, dataDir, fetchDiscovery: okFetch(fetchedAt) });
    store.loadInitial();
    const before = store.snapshot()?.revision ?? 0;
    await store.refresh();
    expect(store.snapshot()).toMatchObject({
      source: "live",
      generatedAt: fetchedAt,
      staleFacilitators: [],
    });
    expect(store.snapshot()?.revision).toBeGreaterThan(before);

    const restarted = createX402DiscoveryStore({ dir, dataDir });
    restarted.loadInitial();
    expect(restarted.snapshot()).toMatchObject({ source: "live", generatedAt: fetchedAt });
  });

  test("a partially failed refresh lists the stale facilitators", async () => {
    const store = createX402DiscoveryStore({
      dir: seedDir({ source: "seed", generatedAt: SEED_GENERATED_AT }),
      dataDir: tempDir(),
      fetchDiscovery: okFetch("2026-10-20T06:00:00.000Z", { cdp: "timeout" }),
    });
    store.loadInitial();
    await store.refresh();
    expect(store.snapshot()?.staleFacilitators).toEqual(["cdp"]);
    // Prior cdp data is kept for the failed facilitator.
    expect(store.snapshot()?.items.cdp).toEqual([item("svc.test")]);
  });

  test("a refresh where every facilitator failed does not relabel old data as live", async () => {
    const store = createX402DiscoveryStore({
      dir: seedDir({ source: "seed", generatedAt: SEED_GENERATED_AT }),
      dataDir: tempDir(),
      fetchDiscovery: okFetch("2026-10-20T06:00:00.000Z", { cdp: "x", dexter: "x", payai: "x" }),
    });
    store.loadInitial();
    const before = store.snapshot();
    await store.refresh();
    expect(store.snapshot()).toMatchObject({ source: "seed", generatedAt: SEED_GENERATED_AT });
    expect(store.snapshot()?.revision).toBe(before?.revision ?? -1);
  });
});

describe("GET /aeo/x402/snapshot + /aeo/x402/signing-key", () => {
  const makeHandler = (
    store = createX402DiscoveryStore({
      dir: seedDir({ source: "seed", generatedAt: SEED_GENERATED_AT }),
    }),
  ) => {
    store.loadInitial();
    // Analytics stays "loading" forever: discovery must not depend on it.
    return {
      store,
      handler: createBffHandler(new Promise<never>(() => {}), null, undefined, store, signer),
    };
  };
  const get = (pathname: string) => new Request(`http://bff${pathname}`);

  test("serves a snapshot agents verify offline with only the published key", async () => {
    // A refresh token is configured, but reading/verifying never uses it.
    process.env.BFF_X402_REFRESH_TOKEN = "secret";
    const { handler } = makeHandler();

    const keyRes = await handler(get("/aeo/x402/signing-key"));
    expect(keyRes.status).toBe(200);
    const { publicKey } = (await keyRes.json()) as { publicKey: string };

    const res = await handler(get("/aeo/x402/snapshot"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const verified = verifyDiscoverySnapshot(await res.json(), {
      publicKey,
      now: new Date("2026-10-20T01:00:00.000Z"),
    });
    expect(verified.source).toBe("seed");
    expect(verified.generatedAt).toBe(SEED_GENERATED_AT);
    expect(verified.keyId).toBe(signer.keyId);
    expect((verified.data as { cdp: unknown[] }).cdp).toEqual([item("svc.test")]);
  });

  test("agents reject the snapshot once it is older than the max age", async () => {
    const { handler } = makeHandler();
    const body = await (await handler(get("/aeo/x402/snapshot"))).json();
    const later = new Date(Date.parse(SEED_GENERATED_AT) + DISCOVERY_SNAPSHOT_MAX_AGE_MS + 1);
    expect(() =>
      verifyDiscoverySnapshot(body, {
        publicKey: signer.publicKeyDocument().publicKey,
        now: later,
      }),
    ).toThrow(DiscoverySnapshotError);
  });

  test("after an authorized refresh the snapshot is re-signed as live", async () => {
    process.env.BFF_X402_REFRESH_TOKEN = "secret";
    const fetchedAt = "2026-10-20T06:00:00.000Z";
    const store = createX402DiscoveryStore({
      dir: seedDir({ source: "seed", generatedAt: SEED_GENERATED_AT }),
      dataDir: tempDir(),
      fetchDiscovery: okFetch(fetchedAt),
    });
    const { handler } = makeHandler(store);
    const first = await (await handler(get("/aeo/x402/snapshot"))).text();

    const refresh = await handler(
      new Request("http://bff/aeo/x402/refresh", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(refresh.status).toBe(200);

    const second = await (await handler(get("/aeo/x402/snapshot"))).text();
    expect(second).not.toBe(first);
    const verified = verifyDiscoverySnapshot(JSON.parse(second), {
      publicKey: signer.publicKeyDocument().publicKey,
      now: new Date("2026-10-20T07:00:00.000Z"),
    });
    expect(verified).toMatchObject({ source: "live", generatedAt: fetchedAt });
  });

  test("signs once per revision (identical bodies until the catalog changes)", async () => {
    const { handler } = makeHandler();
    const a = await (await handler(get("/aeo/x402/snapshot"))).text();
    const b = await (await handler(get("/aeo/x402/snapshot"))).text();
    expect(b).toBe(a);
  });

  test("503 when no snapshot is loaded", async () => {
    const { handler } = makeHandler(createX402DiscoveryStore({ dir: tempDir() }));
    const res = await handler(get("/aeo/x402/snapshot"));
    expect(res.status).toBe(503);
  });

  test("405 for non-GET methods", async () => {
    const { handler } = makeHandler();
    for (const pathname of ["/aeo/x402/snapshot", "/aeo/x402/signing-key"]) {
      const res = await handler(new Request(`http://bff${pathname}`, { method: "POST" }));
      expect(res.status).toBe(405);
    }
  });
});
