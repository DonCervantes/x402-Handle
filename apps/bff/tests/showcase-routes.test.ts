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

  test("disables Stripe server-side pay route even with its former static header", async () => {
    process.env.MPPX_PRIVATE_KEY = `0x${"1".repeat(64)}`;

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/stripe-mpp/pay", {
        method: "POST",
        headers: { "x-flovia-showcase-pay": "stripe-mpp" },
      }),
    );

    expect(response.status).toBe(404);
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

  test("disables Solana server-side pay route even with its former static header", async () => {
    process.env.SOLANA_MPP_PAYER_PRIVATE_KEY = JSON.stringify(Array(64).fill(1));

    const response = await createBffHandler(new Promise<never>(() => {}))(
      request("/showcase/solana-mpp/pay", {
        method: "POST",
        headers: { "x-flovia-showcase-pay": "solana-mpp" },
      }),
    );

    expect(response.status).toBe(404);
  });
});
