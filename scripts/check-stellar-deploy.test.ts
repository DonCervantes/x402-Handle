import { describe, expect, test } from "bun:test";
import { findPlaceholders, stripRustTestModules } from "./check-stellar-deploy";

describe("findPlaceholders", () => {
  test("flags Address::generate in non-test Rust", () => {
    const src = "fn deploy(env: Env) {\n  let token = Address::generate(&env);\n}\n";
    expect(findPlaceholders("contracts/x/src/deploy.rs", src)).toMatchObject([{ line: 2 }]);
  });

  test("ignores Address::generate inside #[cfg(test)] modules", () => {
    const src =
      "fn real() {}\n#[cfg(test)]\nmod test {\n  fn t() { let a = Address::generate(&env); }\n}\n";
    expect(findPlaceholders("contracts/x/src/lib.rs", src)).toEqual([]);
    expect(stripRustTestModules(src).split("\n")).toHaveLength(src.split("\n").length);
  });

  test("flags placeholder payment tokens and random addresses in scripts", () => {
    expect(findPlaceholders("a.ts", "const PAYMENT_TOKEN_PLACEHOLDER = x;")).toHaveLength(1);
    expect(findPlaceholders("a.ts", "const token = Keypair.random().publicKey();")).toHaveLength(1);
    expect(findPlaceholders("a.sh", "--payment_token GABC # placeholder")).toHaveLength(1);
  });

  test("passes a script that uses the network profile", () => {
    const src = "const PAYMENT_TOKEN = stellar.profile.usdc.sacContractId;";
    expect(findPlaceholders("a.ts", src)).toEqual([]);
  });
});
