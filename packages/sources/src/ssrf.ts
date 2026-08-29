// SSRF-protection primitives for outbound HTTPS requests.
//
// Guards against server-side request forgery when the request URL can be
// influenced by untrusted input. Enforcement is threefold:
//
//   1. HTTPS only — plaintext and opaque protocols are rejected outright.
//   2. Explicit host allowlist — the target must (literally) match one of the
//      allowed domains, or be a subdomain of it. Matching is suffix-aware so an
//      allowlist entry of `anchor.example` never matches `evilanchor.example`.
//   3. Non-public IPs are blocked — loopback, link-local (incl. the cloud
//      metadata range 169.254.169.254), private, and reserved addresses are
//      rejected both when the host is a literal IP and after DNS resolution.

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class UnsafeUrlError extends Error {
  /** Stable machine-readable reason. */
  readonly reason: UnsafeUrlReason;

  constructor(reason: UnsafeUrlReason) {
    super(`unsafe URL: ${reason}`);
    this.name = "UnsafeUrlError";
    this.reason = reason;
  }
}

export type UnsafeUrlReason =
  | "invalid-url"
  | "not-https"
  | "credentials"
  | "host-not-allowlisted"
  | "forbidden-ip"
  | "no-addresses";

export type HostResolver = (hostname: string) => Promise<string[]>;

// ─────────────────────────── IP classification ───────────────────────────

type Cidr = { base: bigint; prefix: number };

function parseCidr(cidr: string): Cidr | null {
  const [addr, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  const v4 = ipv4ToBigInt(addr);
  if (v4 !== null) return { base: v4, prefix };
  const v6 = ipv6ToGroups(addr);
  if (v6 !== null) return { base: ipv6Value(v6), prefix };
  return null;
}

/** Converts a dotted-quad IPv4 (or IPv4-mapped suffix) string to a 32-bit number. */
function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return (
    (BigInt(octets[0]) << 24n) |
    (BigInt(octets[1]) << 16n) |
    (BigInt(octets[2]) << 8n) |
    BigInt(octets[3])
  );
}

/** Parses an IPv6 string (supporting `::` compression) into its 8 groups. */
function ipv6ToGroups(ip: string): number[] | null {
  const lower = ip.toLowerCase();
  // Dotted IPv4-mapped suffix (::ffff:127.0.0.1) — normalize to hex groups.
  const dotted = lower.match(/^(.*)::ffff:([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/);
  if (dotted) {
    const octets = [dotted[2], dotted[3], dotted[4], dotted[5]].map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return null;
    const grp1 = (octets[0] << 8) | octets[1];
    const grp2 = (octets[2] << 8) | octets[3];
    // prefix `::ffff:` collapses seven of the ten groups into "::".
    const groups = [0, 0, 0, 0, 0, 0xffff, grp1, grp2];
    const prefix = dotted[1] ?? "";
    if (!prefix) return groups;
    return ipv6ToGroups(`${prefix}::ffff:${grp1.toString(16)}:${grp2.toString(16)}`);
  }

  const doubleColon = lower.indexOf("::");
  const colons = (lower.match(/:/g) ?? []).length;
  if (doubleColon !== -1) {
    if (lower.indexOf("::", doubleColon + 1) !== -1) return null; // only one "::"
  } else if (colons !== 7) {
    return null;
  }

  let left = lower;
  let right = "";
  if (doubleColon !== -1) {
    left = lower.slice(0, doubleColon);
    right = lower.slice(doubleColon + 2);
  }

  const parseGroups = (part: string): number[] => {
    if (!part) return [];
    return part.split(":").map((hex) => (/^[0-9a-f]{1,4}$/.test(hex) ? parseInt(hex, 16) : NaN));
  };

  const leftGroups = parseGroups(left);
  const rightGroups = parseGroups(right);
  if (leftGroups.length === 0 && rightGroups.length === 0) return null;
  if (leftGroups.some(Number.isNaN) || rightGroups.some(Number.isNaN)) return null;

  let groups: number[];
  if (doubleColon !== -1) {
    const filled = 8 - leftGroups.length - rightGroups.length;
    groups = [...leftGroups, ...new Array(filled).fill(0), ...rightGroups];
  } else {
    groups = [...leftGroups];
  }
  if (groups.length !== 8) return null;
  return groups;
}

function ipv6Value(groups: number[]): bigint {
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  return value;
}

/** True when the IPv6 groups are in a banned network (incl. IPv4-mapped). */
function isBannedIpv6Range(groups: number[]): boolean {
  // IPv4-mapped (::ffff:a.b — last 32 bits carry an IPv4 address): re-check as IPv4.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const ipv4 = (BigInt(groups[6]) << 16n) | BigInt(groups[7]);
    return isBannedIpv4(ipv4);
  }
  return isBannedIpv6(ipv6Value(groups));
}

/** True when `value` (a `bits`-wide integer) falls inside the CIDR range. */
function cidrMatches(value: bigint, bits: number, base: bigint, prefix: number): boolean {
  const hostBits = bits - prefix;
  const mask = (1n << BigInt(bits)) - (1n << BigInt(hostBits));
  return (value & mask) === (base & mask);
}

const IPV4_BANNED: Cidr[] = [
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // private
  "100.64.0.0/10", // CGNAT / carrier-grade NAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, incl. 169.254.169.254 metadata
  "172.16.0.0/12", // private
  "192.168.0.0/16", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved
]
  .map(parseCidr)
  .filter((c): c is Cidr => c !== null);

const IPV6_BANNED: Cidr[] = [
  "::/128", // unspecified
  "::1/128", // loopback
  "fc00::/7", // unique-local
  "fe80::/10", // link-local
  "ff00::/8", // multicast
  "2001:10::/28", // ORCHID
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4
  "3fff::/20", // documentation (RFC 9637)
]
  .map(parseCidr)
  .filter((c): c is Cidr => c !== null);

/** True when the IPv4 (32-bit) value is in any banned IPv4 network. */
function isBannedIpv4(value: bigint): boolean {
  return IPV4_BANNED.some((c) => cidrMatches(value, 32, c.base, c.prefix));
}

/** True when the IPv6 (128-bit) value is in any banned IPv6 network. */
function isBannedIpv6(value: bigint): boolean {
  return IPV6_BANNED.some((c) => cidrMatches(value, 128, c.base, c.prefix));
}

/**
 * True when `ip` is a valid IP literal that must never be reached from a BFF:
 * loopback, link-local / metadata, private, or reserved ranges.
 * Non-IP strings are not classified here (return false).
 */
export function isNonPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return false;

  if (version === 4) {
    const value = ipv4ToBigInt(ip);
    return value === null || isBannedIpv4(value);
  }

  const groups = ipv6ToGroups(ip);
  return groups === null || isBannedIpv6Range(groups);
}

/** True when a public, routable IP literal. */
export function isPublicIp(ip: string): boolean {
  return isIP(ip) !== 0 && !isNonPublicIp(ip);
}

// ───────────────────────────── host allowlist ─────────────────────────────

/**
 * True when `hostname` equals an allowlist entry or is a subdomain of one.
 * Entry comparisons are case-insensitive and suffix-safe: `anchor.example`
 * allows `anchor.example` and `kyb.anchor.example` but never `evilanchor.example`.
 * Leading/trailing dots on entries (".anchor.example") are tolerated.
 */
export function hostMatchesAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    if (!entry) continue;
    if (host === entry) return true;
    if (host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

// ───────────────────────────── URL validation ─────────────────────────────

function parseHttpsUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new UnsafeUrlError("invalid-url");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("not-https");
  if (url.username || url.password) throw new UnsafeUrlError("credentials");
  return url;
}

const defaultResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

export type AssertSafeUrlOptions = {
  allowlist: readonly string[];
  /** DNS resolver used to verify resolved addresses are public. Defaults to `node:dns`. */
  resolve?: HostResolver;
};

/**
 * Validates a candidate outbound URL against SSRF protections and returns it.
 * Throws `UnsafeUrlError` when the URL is not HTTPS, carries credentials, its
 * host is not allowlisted, or the host is / resolves to a non-public IP.
 */
export async function assertSafeUrl(urlString: string, opts: AssertSafeUrlOptions): Promise<URL> {
  const url = parseHttpsUrl(urlString);
  const host = url.hostname
    .replace(/^\[|\]$/g, "") // strip IPv6 brackets
    .replace(/\.$/, "") // strip trailing root-dot
    .toLowerCase();

  // Literal-IP hosts skip the allowlist and are gated on public reachability,
  // so a private IP can never be reached even if it is listed in config.
  if (isIP(host) !== 0) {
    if (isNonPublicIp(host)) throw new UnsafeUrlError("forbidden-ip");
    return url;
  }

  if (!hostMatchesAllowlist(host, opts.allowlist)) {
    throw new UnsafeUrlError("host-not-allowlisted");
  }

  // Defense-in-depth: even allowlisted hosts must only resolve to public IPs.
  const resolver = opts.resolve ?? defaultResolver;
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new UnsafeUrlError("no-addresses");
  }
  if (addresses.length === 0) throw new UnsafeUrlError("no-addresses");
  for (const address of addresses) {
    if (isNonPublicIp(address)) throw new UnsafeUrlError("forbidden-ip");
  }

  return url;
}
