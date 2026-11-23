import { describe, expect, test } from "bun:test";
import {
  authorizeShowcasePay,
  checkShowcasePayGate,
  denyShowcasePay,
  SHOWCASE_PAY_HEADER,
  SHOWCASE_PAY_SECRET_ENV,
  withShowcasePayAuth,
} from "../src/showcase/pay-authorization";

const SECRET = "a-long-random-showcase-secret-0123456789";
const requestWith = (value?: string) =>
  new Request("http://localhost/showcase/stripe-mpp/pay", {
    method: "POST",
    headers: value === undefined ? {} : { [SHOWCASE_PAY_HEADER]: value },
  });

describe("showcase pay authorization", () => {
  test("disabled by default with no environment configuration", () => {
    expect(checkShowcasePayGate({})).toEqual({ status: "disabled" });
    expect(authorizeShowcasePay(requestWith(SECRET), {})).toEqual({ status: "disabled" });
  });

  test("explicit opt-in still requires a real configured secret", () => {
    expect(checkShowcasePayGate({ SHOWCASE_PAY_ENABLED: "true" })).toEqual({
      status: "secret_missing",
      requiredEnv: [SHOWCASE_PAY_SECRET_ENV],
    });
    expect(
      checkShowcasePayGate({ SHOWCASE_PAY_ENABLED: "true", SHOWCASE_PAY_SECRET: "short" }),
    ).toEqual({
      status: "secret_too_short",
      requiredEnv: [SHOWCASE_PAY_SECRET_ENV],
      minLength: 16,
    });
    expect(
      checkShowcasePayGate({ SHOWCASE_PAY_ENABLED: "true", SHOWCASE_PAY_SECRET: SECRET }),
    ).toEqual({ status: "ready" });
  });

  test("rejects the old static confirmation values", () => {
    const env = { SHOWCASE_PAY_ENABLED: "true", SHOWCASE_PAY_SECRET: SECRET };
    expect(authorizeShowcasePay(requestWith("stripe-mpp"), env)).toEqual({
      status: "unauthorized",
    });
    expect(authorizeShowcasePay(requestWith("solana-mpp"), env)).toEqual({
      status: "unauthorized",
    });
    expect(authorizeShowcasePay(requestWith(SECRET), env)).toEqual({ status: "ready" });
  });

  test("denial responses never include the secret or the supplied value", async () => {
    const response = denyShowcasePay({ status: "unauthorized" });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).not.toContain(SECRET);
    expect(response.headers.get(SHOWCASE_PAY_HEADER)).toBeNull();
  });

  test("withShowcasePayAuth does not call the payer handler when disabled", async () => {
    let called = 0;
    const response = await withShowcasePayAuth(
      requestWith(SECRET),
      () => {
        called++;
        return new Response("paid");
      },
      {},
    );

    expect(response.status).toBe(403);
    expect(called).toBe(0);
  });

  test("withShowcasePayAuth only calls the payer handler with the real secret", async () => {
    let called = 0;
    const handler = () => {
      called++;
      return new Response("paid");
    };
    const env = { SHOWCASE_PAY_ENABLED: "1", SHOWCASE_PAY_SECRET: SECRET };

    expect((await withShowcasePayAuth(requestWith("stripe-mpp"), handler, env)).status).toBe(401);
    expect(called).toBe(0);
    expect((await withShowcasePayAuth(requestWith(SECRET), handler, env)).status).toBe(200);
    expect(called).toBe(1);
  });
});
