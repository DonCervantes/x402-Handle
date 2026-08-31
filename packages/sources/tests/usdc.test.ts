import { describe, expect, test } from "bun:test";
import { stroopsToUsdc, usdcInfo, usdcToStroops } from "../src/stellar/usdc";

describe("usdcToStroops", () => {
  test("converts decimal USDC amounts to 1e-7 stroops", () => {
    expect(usdcToStroops("0.005")).toBe("50000");
    expect(usdcToStroops(1)).toBe("10000000");
  });

  test("accepts string and number inputs", () => {
    expect(usdcToStroops("0.005")).toBe(usdcToStroops(0.005));
  });

  test("rounds half-up to the nearest stroop (no float dust)", () => {
    expect(usdcToStroops("0.00000015")).toBe("2");
    expect(usdcToStroops("0.00000014")).toBe("1");
  });
});

describe("stroopsToUsdc", () => {
  test("converts stroops back to USDC units", () => {
    expect(stroopsToUsdc("50000")).toBeCloseTo(0.005, 10);
    expect(stroopsToUsdc(10_000_000)).toBe(1);
  });
});

describe("usdcInfo", () => {
  test("matches the native USDC asset metadata used across the workspace", () => {
    expect(usdcInfo.code).toBe("USDC");
    expect(usdcInfo.decimals).toBe(7);
    expect(usdcInfo.issuer).toMatch(/^G[A-Z2-7]{55}$/);
  });
});
