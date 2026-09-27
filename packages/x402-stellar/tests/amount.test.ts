import { describe, expect, test } from "bun:test";
import {
  compareUsdc,
  MAX_STROOPS,
  meetsUsdcAmount,
  parseUsdcToStroops,
  stroopsToUsdc,
} from "../src/amount";

describe("parseUsdcToStroops", () => {
  test.each([
    ["0", 0n],
    ["1", 10_000_000n],
    ["0.005", 50_000n],
    ["0.01", 100_000n],
    ["0.1", 1_000_000n],
    ["0.0000001", 1n],
    ["1.2345678", 12_345_678n],
    ["10.5000000", 105_000_000n],
    ["00.5", 5_000_000n],
    ["922337203685.4775807", MAX_STROOPS],
  ])("parses %p exactly", (input, expected) => {
    expect(parseUsdcToStroops(input)).toBe(expected);
  });

  test.each([
    [""],
    [" 1"],
    ["1 "],
    ["-1"],
    ["+1"],
    ["1e-7"],
    ["0x10"],
    [".5"],
    ["5."],
    ["1,5"],
    ["NaN"],
    ["Infinity"],
    ["0.00000001"], // more precision than Stellar's 7 decimals
    ["922337203685.4775808"], // int64 overflow
  ])("rejects %p", (input) => {
    expect(() => parseUsdcToStroops(input)).toThrow(/invalid USDC amount/);
  });
});

describe("stroopsToUsdc", () => {
  test.each([
    [0n, "0"],
    [1n, "0.0000001"],
    [50_000n, "0.005"],
    [10_000_000n, "1"],
    [105_000_000n, "10.5"],
    [MAX_STROOPS, "922337203685.4775807"],
  ])("formats %p as %p", (input, expected) => {
    expect(stroopsToUsdc(input)).toBe(expected);
  });

  test("round-trips with parseUsdcToStroops", () => {
    for (const s of ["0.005", "1.2345678", "0.0000001", "123456.7"]) {
      expect(stroopsToUsdc(parseUsdcToStroops(s))).toBe(s);
    }
  });

  test("rejects negative or out-of-range values", () => {
    expect(() => stroopsToUsdc(-1n)).toThrow();
    expect(() => stroopsToUsdc(MAX_STROOPS + 1n)).toThrow();
  });
});

describe("compareUsdc / meetsUsdcAmount", () => {
  test("typical USDC prices", () => {
    expect(meetsUsdcAmount("0.005", "0.005")).toBe(true);
    expect(meetsUsdcAmount("0.0050000", "0.005")).toBe(true);
    expect(meetsUsdcAmount("0.01", "0.005")).toBe(true);
    expect(meetsUsdcAmount("0.0049999", "0.005")).toBe(false);
    expect(compareUsdc("0.1", "0.10")).toBe(0);
  });

  test("detects a one-stroop underpayment where Number() cannot", () => {
    // Both strings round to the same IEEE-754 double.
    expect(Number("922337203685.4775806")).toBe(Number("922337203685.4775807"));
    expect(meetsUsdcAmount("922337203685.4775806", "922337203685.4775807")).toBe(false);
  });

  test("detects 0.1 + 0.2 style fractions exactly", () => {
    expect(meetsUsdcAmount("0.3", "0.3000000")).toBe(true);
    expect(meetsUsdcAmount("0.2999999", "0.3")).toBe(false);
  });

  test("throws on a malformed expected amount instead of accepting any payment", () => {
    // With Number(), `x < NaN` is false, so every payment would pass.
    expect(() => meetsUsdcAmount("0.0000001", "abc")).toThrow(/invalid USDC amount/);
  });
});
