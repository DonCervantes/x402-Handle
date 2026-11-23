import { afterEach, describe, expect, test } from "bun:test";
import { createBffHandler } from "../src/http";

const request = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, init);
const originalHitPayApiKey = process.env.HITPAY_API_KEY;
const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
const originalMppxPrivateKey = process.env.MPPX_PRIVATE_KEY;
const originalSolanaRecipient = process.env.SOLANA_MPP_RECIPIENT;
const originalSolanaNetwork = process.env.SOLANA_MPP_NETWORK;
const originalSolanaPayerKey = process.env.SOLANA_MPP_PAYER_PRIVATE_KEY;
const originalShowcasePayEnabled = process.env.SHOWCASE_PAY_ENABLED;
const originalShowcasePaySecret = process.env.SHOWCASE_PAY_SECRET;
const TEST_PAY_SECRET = "showcase-pay-test-secret-0123456789";

const enableShowcasePay = () => {
  process.env.SHOWCASE_PAY_ENABLED = "true";
  process.env.SHOWCASE_PAY_SECRET = TEST_PAY_SECRET;
};

const payHeaders = () => ({ "x-flovia-showcase-pay": TEST_PAY_SECRET });

describe("showcase paid API routes", () => {
  afterEach(() => {
    if (originalHitPayApiKey === undefined) {
      delete process.env.HITPAY_API_KEY;
    } else {
      process.env.HITPAY_API_KEY = originalHitPayApiKey;
    }

    if (originalStripeSecretKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    }

    if (originalMppxPrivateKey === undefined) {
      delete process.env.MPPX_PRIVATE_KEY;
    } else {
      process.env.MPPX_PRIVATE_KEY = originalMppxPrivateKey;
    }

    if (originalSolanaRecipient === undefined) {
      delete process.env.SOLANA_MPP_RECIPIENT;
    } else {
      process.env.SOLANA_MPP_RECIPIENT = originalSolanaRecipient;
    }

    if (originalSolanaNetwork === undefined) {
      delete process.env.SOLANA_MPP_NETWORK;
    } else {
      process.env.SOLANA_MPP_NETWORK = originalSolanaNetwork;
    }

    if (originalSolanaPayerKey === undefined) {
      delete process.env.SOLANA_MPP_PAYER_PRIVATE_KEY;
    } else {
      process.env.SOLANA_MPP_PAYER_PRIVATE_KEY = originalSolanaPayerKey;
    }

    if (originalShowcasePayEnabled === undefined) {
      delete process.env.SHOWCASE_PAY_ENABLED;
    } else {
      process.env.SHOWCASE_PAY_ENABLED = originalShowcasePayEnabled;
    }

    if (originalShowcasePaySecret === undefined) {
      delete process.env.SHOWCASE_PAY_SECRET;
    } else {
      process.env.SHOWCASE_PAY_SECRET = originalShowcasePaySecret;
    }
  });

  test("returns clear Stripe configuration error when credentials are missing", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/stripe-mpp/paid"),
    );
    const body = (await response.json()) as {
      error: string;
      requiredEnv: string[];
      floviaEvent: { status: string; latencyMs: number };
    };

    expect(response.status).toBe(503);
    expect(body.error).toBe("stripe_mpp_not_configured");
    expect(body.requiredEnv).toContain("STRIPE_SECRET_KEY");
    expect(body.floviaEvent.status).toBe("configuration_required");
    expect(body.floviaEvent.latencyMs).toBeGreaterThan(0);
  });

  test("does not accept demo credentials for real Stripe MPP flow", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/stripe-mpp/paid?credential=demo-paid"),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(503);
    expect(body.error).toBe("stripe_mpp_not_configured");
  });

  test("rejects malformed Stripe MPP credentials before creating PaymentIntents", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_showcase";

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/stripe-mpp/paid", {
        headers: { authorization: "Payment not-a-credential" },
      }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_stripe_mpp_credential");
  });

  test("returns clear Stripe pay button error when MPPX private key is missing", async () => {
    delete process.env.MPPX_PRIVATE_KEY;
    enableShowcasePay();

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/stripe-mpp/pay", {
        method: "POST",
        headers: payHeaders(),
      }),
    );
    const body = (await response.json()) as { error: string; requiredEnv: string[] };

    expect(response.status).toBe(503);
    expect(body.error).toBe("mppx_private_key_not_configured");
    expect(body.requiredEnv).toContain("MPPX_PRIVATE_KEY");
  });

  test("requires the real secret for Stripe pay after opt-in", async () => {
    enableShowcasePay();
    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/stripe-mpp/pay", { method: "POST" }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("showcase_pay_unauthorized");
  });

  test("returns clear HitPay configuration error when credentials are missing", async () => {
    delete process.env.HITPAY_API_KEY;
    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/hitpay-mpp/paid"),
    );
    const body = (await response.json()) as { error: string; requiredEnv: string[] };

    expect(response.status).toBe(503);
    expect(body.error).toBe("hitpay_mpp_not_configured");
    expect(body.requiredEnv).toContain("HITPAY_API_KEY");
  });

  test("does not accept demo credentials for real HitPay MPP flow", async () => {
    delete process.env.HITPAY_API_KEY;
    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/hitpay-mpp/paid?credential=demo-paid"),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(503);
    expect(body.error).toBe("hitpay_mpp_not_configured");
  });

  test("rejects non-GET showcase requests", async () => {
    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/hitpay-mpp/paid", { method: "POST" }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(405);
    expect(body.error).toBe("method_not_allowed");
  });

  test("returns clear Solana configuration error when recipient is missing", async () => {
    delete process.env.SOLANA_MPP_RECIPIENT;
    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/paid"),
    );
    const body = (await response.json()) as {
      error: string;
      requiredEnv: string[];
      floviaEvent: { status: string; latencyMs: number };
    };

    expect(response.status).toBe(503);
    expect(body.error).toBe("solana_mpp_not_configured");
    expect(body.requiredEnv).toContain("SOLANA_MPP_RECIPIENT");
    expect(body.floviaEvent.status).toBe("configuration_required");
    expect(body.floviaEvent.latencyMs).toBeGreaterThan(0);
  });

  test("the Solana not_configured response reflects the configured network", async () => {
    delete process.env.SOLANA_MPP_RECIPIENT;
    process.env.SOLANA_MPP_NETWORK = "mainnet-beta";

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/paid"),
    );
    const body = (await response.json()) as {
      error: string;
      message: string;
      floviaEvent: { joinedInsight: string; payment: { network: string } };
    };

    expect(response.status).toBe(503);
    expect(body.error).toBe("solana_mpp_not_configured");
    expect(body.message).toContain("on mainnet-beta");
    expect(body.message).not.toContain("devnet");
    expect(body.floviaEvent.joinedInsight).toContain("mainnet-beta recipient");
    expect(body.floviaEvent.payment.network).toBe("solana-mainnet-beta");
  });

  test("rejects invalid SOLANA_MPP_NETWORK values before reaching the broker", async () => {
    process.env.SOLANA_MPP_NETWORK = "totally-not-a-network";

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/paid"),
    );
    const body = (await response.json()) as {
      error: string;
      allowedEnv: { SOLANA_MPP_NETWORK: readonly string[] };
      floviaEvent: { status: string };
    };

    expect(response.status).toBe(503);
    expect(body.error).toBe("solana_mpp_invalid_network");
    expect(body.allowedEnv.SOLANA_MPP_NETWORK).toEqual(["devnet", "localnet", "mainnet-beta"]);
    expect(body.floviaEvent.status).toBe("configuration_invalid");
  });

  test("rejects non-GET Solana showcase requests", async () => {
    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/paid", { method: "POST" }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(405);
    expect(body.error).toBe("method_not_allowed");
  });

  test("requires the real secret for Solana pay after opt-in", async () => {
    enableShowcasePay();
    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/pay", { method: "POST" }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("showcase_pay_unauthorized");
  });

  test("returns clear Solana pay error when payer private key is missing", async () => {
    delete process.env.SOLANA_MPP_PAYER_PRIVATE_KEY;
    enableShowcasePay();

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/pay", {
        method: "POST",
        headers: payHeaders(),
      }),
    );
    const body = (await response.json()) as { error: string; requiredEnv: string[] };

    expect(response.status).toBe(503);
    expect(body.error).toBe("solana_mpp_payer_not_configured");
    expect(body.requiredEnv).toContain("SOLANA_MPP_PAYER_PRIVATE_KEY");
  });

  test("rejects malformed Solana payer private keys before signing", async () => {
    process.env.SOLANA_MPP_PAYER_PRIVATE_KEY = "[1,2,3]";
    enableShowcasePay();

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/pay", {
        method: "POST",
        headers: payHeaders(),
      }),
    );
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(503);
    expect(body.error).toBe("solana_mpp_payer_key_invalid");
    expect(body.message).toContain("64");
  });

  test("rejects base58 payer keys that decode to the wrong length", async () => {
    // "2" is base58 for 0x01 — only 1 byte, far short of the 64 required.
    process.env.SOLANA_MPP_PAYER_PRIVATE_KEY = "2";
    enableShowcasePay();

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/pay", {
        method: "POST",
        headers: payHeaders(),
      }),
    );
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(503);
    expect(body.error).toBe("solana_mpp_payer_key_invalid");
    expect(body.message).toContain("64 bytes");
    expect(body.message).toContain("base58");
  });

  test("accepts a valid 64-byte JSON payer keypair (config-time only; payment requires devnet funding)", async () => {
    // Generate a real ed25519 keypair, pack into the Solana CLI 64-byte format.
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const skJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pkJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const skRaw = Buffer.from(skJwk.d ?? "", "base64url");
    const pkRaw = Buffer.from(pkJwk.x ?? "", "base64url");
    const combined = new Uint8Array(64);
    combined.set(skRaw, 0);
    combined.set(pkRaw, 32);
    process.env.SOLANA_MPP_PAYER_PRIVATE_KEY = JSON.stringify(Array.from(combined));
    // Pin a recipient so the assertion below isolates payer-key parsing from
    // the unrelated `solana_mpp_not_configured` (missing recipient) 503 path.
    // Without this, CI runs that don't define SOLANA_MPP_RECIPIENT see the
    // paid handler short-circuit at 503 before the payment stage is reached.
    process.env.SOLANA_MPP_RECIPIENT = "9cVgh9GaPrQ7nsCEwx1GE9eqSArs5XodyMX7vLRhHp4F";
    enableShowcasePay();

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/pay", {
        method: "POST",
        headers: payHeaders(),
      }),
    );
    const body = (await response.json()) as { error?: string };

    // The route should NOT bounce on key parsing. It will subsequently fail at
    // the payment stage (502 for unfunded wallet / network unreachable), but
    // that proves the key was accepted.
    expect(response.status).not.toBe(503);
    expect(body.error).not.toBe("solana_mpp_payer_key_invalid");
    expect(body.error).not.toBe("solana_mpp_payer_not_configured");
    expect(body.error).not.toBe("solana_mpp_not_configured");
  });

  test("rejects POST with the old static confirmation header", async () => {
    enableShowcasePay();
    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/pay", {
        method: "POST",
        headers: { "x-flovia-showcase-pay": "solana-mpp" },
      }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("showcase_pay_unauthorized");
  });

  test("both /pay routes are disabled by default even with payer keys present", async () => {
    delete process.env.SHOWCASE_PAY_ENABLED;
    delete process.env.SHOWCASE_PAY_SECRET;
    process.env.MPPX_PRIVATE_KEY = "0x" + "1".repeat(64);
    process.env.SOLANA_MPP_PAYER_PRIVATE_KEY = JSON.stringify(Array.from({ length: 64 }, () => 1));

    for (const path of ["/showcase/stripe-mpp/pay", "/showcase/solana-mpp/pay"]) {
      const response = await createBffHandler(new Promise<never>(() => {}))(
        request(path, { method: "POST", headers: payHeaders() }),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(403);
      expect(body.error).toBe("showcase_pay_disabled");
      expect(JSON.stringify(body)).not.toContain(TEST_PAY_SECRET);
    }
  });

  test("opt-in without a configured secret does not reach the payer handlers", async () => {
    delete process.env.SHOWCASE_PAY_SECRET;
    process.env.SHOWCASE_PAY_ENABLED = "true";
    process.env.MPPX_PRIVATE_KEY = "0x" + "1".repeat(64);
    process.env.SOLANA_MPP_PAYER_PRIVATE_KEY = JSON.stringify(Array.from({ length: 64 }, () => 1));

    for (const path of ["/showcase/stripe-mpp/pay", "/showcase/solana-mpp/pay"]) {
      const response = await createBffHandler(new Promise<never>(() => {}))(
        request(path, { method: "POST", headers: payHeaders() }),
      );
      const body = (await response.json()) as { error: string; requiredEnv: string[] };

      expect(response.status).toBe(503);
      expect(body.error).toBe("showcase_pay_not_configured");
      expect(body.requiredEnv).toContain("SHOWCASE_PAY_SECRET");
    }
  });

  test("an authorized response never echoes the pay secret", async () => {
    enableShowcasePay();
    delete process.env.MPPX_PRIVATE_KEY;

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/stripe-mpp/pay", { method: "POST", headers: payHeaders() }),
    );
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(text).not.toContain(TEST_PAY_SECRET);
    expect(response.headers.get("x-flovia-showcase-pay")).toBeNull();
  });
});
