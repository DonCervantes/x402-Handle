import type { X402Challenge } from "./types";

export interface SponsorshipPolicy {
  enabled: boolean;
  sponsorAccount: string;
  dailyCapUsdc: string;
  allowedProviders?: string[];
}

export interface SponsorshipRequest {
  challenge: X402Challenge;
  provider: string;
  requestedAmountUsdc: string;
  spentTodayUsdc: string;
}

export type SponsorshipDecision =
  | { sponsored: true; remainingDailyCapUsdc: string }
  | { sponsored: false; reason: SponsorshipRejectionReason };

export type SponsorshipRejectionReason =
  | "disabled"
  | "invalid_policy"
  | "provider_not_allowed"
  | "challenge_not_bound"
  | "amount_mismatch"
  | "daily_cap_exceeded"
  | "public_network_disabled";

/**
 * Decides whether a fee sponsor may handle a payment. This policy does not
 * sign or submit transactions; callers must bind the payment to the issued
 * challenge before invoking any fee-bump implementation.
 */
export function decideSponsorship(
  policy: SponsorshipPolicy,
  request: SponsorshipRequest,
): SponsorshipDecision {
  if (!policy.enabled) return { sponsored: false, reason: "disabled" };
  if (!policy.sponsorAccount || !isPositiveDecimal(policy.dailyCapUsdc)) {
    return { sponsored: false, reason: "invalid_policy" };
  }
  if (request.challenge.network === "public") {
    return { sponsored: false, reason: "public_network_disabled" };
  }
  if (policy.allowedProviders && !policy.allowedProviders.includes(request.provider)) {
    return { sponsored: false, reason: "provider_not_allowed" };
  }
  if (request.challenge.destination !== request.provider) {
    return { sponsored: false, reason: "challenge_not_bound" };
  }
  if (!isNonNegativeDecimal(request.requestedAmountUsdc) ||
      request.requestedAmountUsdc !== request.challenge.amount) {
    return { sponsored: false, reason: "amount_mismatch" };
  }
  if (!isNonNegativeDecimal(request.spentTodayUsdc)) {
    return { sponsored: false, reason: "invalid_policy" };
  }

  if (decimalCompare(request.spentTodayUsdc, policy.dailyCapUsdc) > 0) {
    return { sponsored: false, reason: "daily_cap_exceeded" };
  }
  const remaining = decimalSub(policy.dailyCapUsdc, request.spentTodayUsdc);
  if (decimalCompare(request.requestedAmountUsdc, remaining) > 0) {
    return { sponsored: false, reason: "daily_cap_exceeded" };
  }
  return { sponsored: true, remainingDailyCapUsdc: decimalSub(remaining, request.requestedAmountUsdc) };
}

function isPositiveDecimal(value: string): boolean {
  return isNonNegativeDecimal(value) && Number(value) > 0;
}

function isNonNegativeDecimal(value: string): boolean {
  return /^\d+(?:\.\d{1,7})?$/.test(value) && Number.isFinite(Number(value));
}

function decimalCompare(left: string, right: string): number {
  const [li, lf = ""] = left.split(".");
  const [ri, rf = ""] = right.split(".");
  const leftFixed = BigInt(`${li}${lf.padEnd(7, "0")}`);
  const rightFixed = BigInt(`${ri}${rf.padEnd(7, "0")}`);
  return leftFixed < rightFixed ? -1 : leftFixed > rightFixed ? 1 : 0;
}

function decimalSub(left: string, right: string): string {
  const [li, lf = ""] = left.split(".");
  const [ri, rf = ""] = right.split(".");
  const result = BigInt(`${li}${lf.padEnd(7, "0")}`) - BigInt(`${ri}${rf.padEnd(7, "0")}`);
  const integer = result / 10_000_000n;
  const fraction = (result % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}
