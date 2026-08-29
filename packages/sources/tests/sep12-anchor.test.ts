import { afterEach, describe, expect, test } from "bun:test";
import { querySep12Anchor } from "../src/kyb/sep12-anchor";

const anchorOpts = {
  anchorBaseUrl: "https://anchor.example/sep12",
  account: "GABC",
  jwt: "eyJ0",
};

const allowPublic = ["anchor.example"];

const resolvePublic = async () => ["93.184.216.34"];

function stubFetch() {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers });
    return new Response(JSON.stringify({ status: "accepted", account: "GABC" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

describe("querySep12Anchor SSRF enforcement", () => {
  afterEach(() => {
    delete process.env.SEP12_ANCHOR_ALLOWLIST;
  });

  test("fetches SEP-12 data for a safe, allowlisted https anchor", async () => {
    const stub = stubFetch();
    try {
      const result = await querySep12Anchor({
        ...anchorOpts,
        allowlist: allowPublic,
        resolve: resolvePublic,
      });
      expect(result).toEqual({ status: "accepted", account: "GABC" });
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].url).toBe("https://anchor.example/sep12/customer?account=GABC");
      expect(stub.calls[0].headers).toEqual({
        Authorization: "Bearer eyJ0",
      });
    } finally {
      stub.restore();
    }
  });

  test("rejects non-HTTPS anchor without fetching", async () => {
    const stub = stubFetch();
    try {
      await expect(
        querySep12Anchor({
          ...anchorOpts,
          anchorBaseUrl: "http://anchor.example/sep12",
          allowlist: allowPublic,
          resolve: resolvePublic,
        }),
      ).rejects.toThrow("unsafe URL");
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  test("rejects anchors outside the allowlist without fetching", async () => {
    const stub = stubFetch();
    try {
      await expect(
        querySep12Anchor({
          ...anchorOpts,
          anchorBaseUrl: "https://evil.example/sep12",
          allowlist: allowPublic,
          resolve: resolvePublic,
        }),
      ).rejects.toThrow("unsafe URL");
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  test("rejects a loopback / metadata anchor even if configured", async () => {
    const stub = stubFetch();
    try {
      await expect(
        querySep12Anchor({
          ...anchorOpts,
          anchorBaseUrl: "https://127.0.0.1/sep12",
          allowlist: ["127.0.0.1", "169.254.169.254"],
        }),
      ).rejects.toThrow("unsafe URL");
      await expect(
        querySep12Anchor({
          ...anchorOpts,
          anchorBaseUrl: "https://169.254.169.254/latest",
          allowlist: ["127.0.0.1", "169.254.169.254"],
        }),
      ).rejects.toThrow("unsafe URL");
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  test("defaults the allowlist to $SEP12_ANCHOR_ALLOWLIST from env", async () => {
    process.env.SEP12_ANCHOR_ALLOWLIST = "anchor.example, other.example ";
    const stub = stubFetch();
    try {
      await expect(
        querySep12Anchor({
          ...anchorOpts,
          anchorBaseUrl: "https://other.example/sep12",
          resolve: resolvePublic,
        }),
      ).resolves.toBeDefined();
    } finally {
      stub.restore();
    }
  });

  test("rejects everything when the env allowlist is empty", async () => {
    delete process.env.SEP12_ANCHOR_ALLOWLIST;
    const stub = stubFetch();
    try {
      await expect(querySep12Anchor(anchorOpts)).rejects.toThrow("unsafe URL");
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });
});
