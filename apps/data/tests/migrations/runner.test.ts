import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { defaultMigrationsDir, readMigrationFiles } from "../../src/migrations/runner.js";

describe("migration runner", () => {
  test("reads copied SQL migrations in version order", async () => {
    const migrations = await readMigrationFiles();

    expect(basename(defaultMigrationsDir())).toBe("migrations");
    expect(migrations).toHaveLength(19);
    expect(migrations.map((migration) => migration.version)).toEqual([
      "001",
      "002",
      "003",
      "004",
      "005",
      "006",
      "007",
      "008",
      "009",
      "010",
      "011",
      "012",
      "013",
      "014",
      "015",
      "016",
      "017",
      "018",
      "019",
    ]);
  });
});
