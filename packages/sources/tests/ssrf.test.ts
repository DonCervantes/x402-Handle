import { describe, expect, test } from "bun:test";
import {
  assertSafeUrl,
  hostMatchesAllowlist,
  isNonPublicIp,
  isPublicIp,
  UnsafeUrlError,
} from "../src/ssrf";

const ALLOW = ["anchor.example", "api.otter.services"];

const resolvePublic = async () => ["93.184.216.34"];

const resolverOf =
  (...ips: string[]) =>
  async () =>
    ips;

const safe = (url: string, allowlist = ALLOW) =>
  assertSafeUrl(url, { allowlist, resolve: resolvePublic });

describe("isPublicIp / isNonPublicIp", () => {
  test("public IPv4 and IPv6 are allowed", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("93.184.216.34")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
  });

  test("loopback, private, link-local, metadata are blocked", () => {
    expect(isNonPublicIp("127.0.0.1")).toBe(true);
    expect(isNonPublicIp("10.0.0.1")).toBe(true);
    expect(isNonPublicIp("172.16.5.4")).toBe(true);
    expect(isNonPublicIp("192.168.1.1")).toBe(true);
    expect(isNonPublicIp("169.254.169.254")).toBe(true); // cloud metadata
    expect(isNonPublicIp("::1")).toBe(true);
    expect(isNonPublicIp("fe80::1")).toBe(true);
    expect(isNonPublicIp("fc00::1")).toBe(true);
  });

  test("non-IP input is not wrongly classified", () => {
    expect(isPublicIp("anchor.example")).toBe(false);
    expect(isNonPublicIp("anchor.example")).toBe(false);
  });
});

describe("hostMatchesAllowlist", () => {
  test("allows exact matches and subdomains", () => {
    expect(hostMatchesAllowlist("anchor.example", ALLOW)).toBe(true);
    expect(hostMatchesAllowlist("kyb.anchor.example", ALLOW)).toBe(true);
    expect(hostMatchesAllowlist("api.otter.services", ALLOW)).toBe(true);
  });

  test("rejects lookalike domains (suffix confusion)", () => {
    expect(hostMatchesAllowlist("evilanchor.example", ALLOW)).toBe(false);
    expect(hostMatchesAllowlist("notanchor.example", ALLOW)).toBe(false);
    expect(hostMatchesAllowlist("anchor.example.evil.com", ALLOW)).toBe(false);
  });

  test("tolerates case and leading/trailing dots", () => {
    expect(hostMatchesAllowlist("ANCHOR.EXAMPLE", [".Anchor.Example."])).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  test("accepts an https, allowlisted host that resolves to public IPs", async () => {
    await expect(safe("https://anchor.example/sep12/customer")).resolves.toBeInstanceOf(URL);
  });

  test("accepts a public literal IP host in the allowlist", async () => {
    await expect(safe("https://93.184.216.34/sep12", ["93.184.216.34"])).resolves.toBeInstanceOf(
      URL,
    );
  });

  test("rejects non-HTTPS schemes", async () => {
    await expect(safe("http://anchor.example/customer")).rejects.toThrow(UnsafeUrlError);
    await expect(safe("ftp://anchor.example/file")).rejects.toThrow(UnsafeUrlError);
  });

  test("rejects hosts not in the allowlist", async () => {
    await expect(safe("https://evil.example/customer")).rejects.toThrow(UnsafeUrlError);
    await expect(safe("https://evilanchor.example/customer")).rejects.toThrow(UnsafeUrlError);
  });

  test("rejects a loopback literal IP even when listed in the allowlist", async () => {
    await expect(safe("https://127.0.0.1/customer", ["127.0.0.1"])).rejects.toThrow(UnsafeUrlError);
  });

  test("rejects cloud metadata literal IP", async () => {
    await expect(safe("https://169.254.169.254/latest/meta-data")).rejects.toThrow(UnsafeUrlError);
  });

  test("rejects IPv6 literals that are loopback / link-local", async () => {
    await expect(safe("https://[::1]/customer")).rejects.toThrow(UnsafeUrlError);
    await expect(safe("https://[fe80::1]/customer")).rejects.toThrow(UnsafeUrlError);
  });

  test("rejects IPv4-mapped loopback literals", async () => {
    await expect(safe("https://[::ffff:127.0.0.1]/customer")).rejects.toThrow(UnsafeUrlError);
  });

  test("rejects invalid URLs and embedded credentials", async () => {
    await expect(safe("not a url")).rejects.toThrow(UnsafeUrlError);
    await expect(safe("https://user:pass@anchor.example/customer")).rejects.toThrow(UnsafeUrlError);
  });

  test("rejects allowlisted host that resolves to a private/link-local IP", async () => {
    await expect(
      assertSafeUrl("https://anchor.example/customer", {
        allowlist: ALLOW,
        resolve: await resolverOf("127.0.0.1"),
      }),
    ).rejects.toThrow(UnsafeUrlError);

    await expect(
      assertSafeUrl("https://anchor.example/customer", {
        allowlist: ALLOW,
        resolve: await resolverOf("169.254.169.254"),
      }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  test("rejects allowlisted host that fails to resolve", async () => {
    await expect(
      assertSafeUrl("https://anchor.example/customer", {
        allowlist: ALLOW,
        resolve: async () => [],
      }),
    ).rejects.toThrow(UnsafeUrlError);

    await expect(
      assertSafeUrl("https://anchor.example/customer", {
        allowlist: ALLOW,
        resolve: async () => {
          throw new Error("NXDOMAIN");
        },
      }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  test("accepts allowlisted host that resolves to a public IP", async () => {
    await expect(
      assertSafeUrl("https://anchor.example/customer", {
        allowlist: ALLOW,
        resolve: await resolverOf("93.184.216.34"),
      }),
    ).resolves.toBeInstanceOf(URL);
  });
});
