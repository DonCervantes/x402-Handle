import { describe, expect, test } from "bun:test";
import { Flovia } from "../src/index";

describe("Flovia agent SDK client", () => {
  test("throws error if secret is missing", () => {
    expect(() => new Flovia({ secret: "" } as any)).toThrow("missing 'secret'");
  });

  test("initializes with default testnet options", () => {
    const client = new Flovia({
      secret: "SDJKSDFJKLSDJFKSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJ",
    });
    expect(client).toBeInstanceOf(Flovia);
  });

  test("normalizes bffUrl by stripping trailing slash", () => {
    const client = new Flovia({
      secret: "SDJKSDFJKLSDJFKSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJFKLSDJ",
      bffUrl: "http://localhost:3001/",
    });
    expect((client as any).bffUrl).toBe("http://localhost:3001");
  });
});
