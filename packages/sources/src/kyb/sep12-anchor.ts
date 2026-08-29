// SEP-12 KYC API integration.
// https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
// En hackathon: stub. En mes 1-3: implementación completa.
//
// The anchor URL is validated against SSRF protections (HTTPS only, explicit
// domain allowlist, non-public IPs blocked) before any network I/O happens.

import { assertSafeUrl, type HostResolver } from "../ssrf";
import { fetchWithRetry } from "../transport";

function defaultAnchorAllowlist(): string[] {
  return (process.env.SEP12_ANCHOR_ALLOWLIST ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

export async function querySep12Anchor(opts: {
  anchorBaseUrl: string;
  account: string;
  jwt: string;
  /** Domain allowlist override (defaults to env $SEP12_ANCHOR_ALLOWLIST). */
  allowlist?: readonly string[];
  /** DNS resolver override for SSRF checks (tests). */
  resolve?: HostResolver;
}) {
  await assertSafeUrl(opts.anchorBaseUrl, {
    allowlist: opts.allowlist ?? defaultAnchorAllowlist(),
    resolve: opts.resolve,
  });

  const res = await fetchWithRetry(`${opts.anchorBaseUrl}/customer?account=${opts.account}`, {
    headers: { Authorization: `Bearer ${opts.jwt}` },
  });
  if (!res.ok) return null;
  return await res.json();
}
