import { describe, expect, test } from "bun:test";
import { checkImportBoundaries } from "./check-import-boundaries";

describe("checkImportBoundaries", () => {
  test("validates repository import boundaries with zero violations", () => {
    const result = checkImportBoundaries();
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("handles empty or custom directory gracefully", () => {
    const result = checkImportBoundaries(process.cwd());
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.violations)).toBe(true);
  });
});
