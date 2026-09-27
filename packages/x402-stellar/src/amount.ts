// Exact USDC amount handling in stroops (1 USDC = 10^7 stroops, Stellar's
// fixed 7-decimal precision). Never route amounts through Number(): IEEE-754
// rounding can accept an underpayment, and Number("abc") is NaN, which makes
// every `paid < expected` comparison false.

export const STROOPS_PER_USDC = 10_000_000n;
/** Stellar amounts are signed int64 stroops. */
export const MAX_STROOPS = 9_223_372_036_854_775_807n;

const DECIMALS = 7;
const AMOUNT_RE = /^(\d+)(?:\.(\d{1,7}))?$/;

/** Parses a Stellar decimal string ("0.005") into stroops. Throws if malformed. */
export function parseUsdcToStroops(amount: string): bigint {
  const match = AMOUNT_RE.exec(amount);
  if (!match) throw new Error(`invalid USDC amount: ${JSON.stringify(amount)}`);
  const [, integer, fraction = ""] = match;
  const stroops = BigInt(integer) * STROOPS_PER_USDC + BigInt(fraction.padEnd(DECIMALS, "0"));
  if (stroops > MAX_STROOPS)
    throw new Error(`invalid USDC amount: ${JSON.stringify(amount)} exceeds int64 stroops`);
  return stroops;
}

/** Formats stroops as a canonical decimal string without trailing zeros. */
export function stroopsToUsdc(stroops: bigint): string {
  if (stroops < 0n || stroops > MAX_STROOPS) throw new Error(`stroops out of range: ${stroops}`);
  const integer = stroops / STROOPS_PER_USDC;
  const fraction = (stroops % STROOPS_PER_USDC)
    .toString()
    .padStart(DECIMALS, "0")
    .replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}

/** -1, 0 or 1. Throws if either side is malformed. */
export function compareUsdc(left: string, right: string): -1 | 0 | 1 {
  const l = parseUsdcToStroops(left);
  const r = parseUsdcToStroops(right);
  return l < r ? -1 : l > r ? 1 : 0;
}

/** True if `paid` covers `expected`. Throws if either side is malformed. */
export function meetsUsdcAmount(paid: string, expected: string): boolean {
  return compareUsdc(paid, expected) >= 0;
}

/** True if `amount` is a well-formed Stellar decimal within int64 stroops. */
export function isUsdcAmount(amount: string): boolean {
  try {
    parseUsdcToStroops(amount);
    return true;
  } catch {
    return false;
  }
}
