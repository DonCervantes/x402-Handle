import crypto from "node:crypto";
import { Credential } from "mppx";
import { Mppx as ServerMppx, tempo } from "mppx/server";
import Stripe from "stripe";
import { flovia, json } from "./flovia-track-paid-api";

const endpoint = "/showcase/stripe-mpp/paid";
const provider = "stripe" as const;
const rail = "mpp" as const;
const amount = "1.00";
const currency = "usd";
const pathUsd = "0x20c0000000000000000000000000000000000000";
const tempoDecimals = 6;
const paymentCacheTtlMs = 5 * 60 * 1000;

type StripeShowcaseConfig = {
  client: Stripe;
  mppSecretKey: string;
};

const paymentCache = new Map<string, { paymentIntentId: string; expiresAt: number }>();
let cachedConfig: StripeShowcaseConfig | null = null;

class InvalidStripeMppCredentialError extends Error {
  constructor() {
    super("Invalid Stripe MPP Payment credential.");
    this.name = "InvalidStripeMppCredentialError";
  }
}

const envValue = (key: string) => {
  const value = process.env[key]?.trim();
  return value ? value : null;
};

const resolveStripeShowcaseConfig = () => {
  const stripeSecretKey = envValue("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) return null;
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    client: new Stripe(stripeSecretKey, {
      // Stripe crypto PaymentIntent support is currently exposed on preview versions.
      // @ts-expect-error Stripe preview versions can lag the published SDK API version union.
      apiVersion: "2026-03-04.preview",
      appInfo: {
        name: "flovia-poc/showcase-stripe-mpp",
        url: "https://github.com/flovia/poc",
        version: "1.0.0",
      },
    }),
    mppSecretKey: envValue("MPP_SECRET_KEY") ?? crypto.randomBytes(32).toString("base64"),
  };

  return cachedConfig;
};

const prunePaymentCache = () => {
  const now = Date.now();
  for (const [recipient, cached] of paymentCache.entries()) {
    if (cached.expiresAt <= now) paymentCache.delete(recipient);
  }
};

const getPayToAddressFromCredential = (request: Request) => {
  const authorization = request.headers.get("authorization");
  if (!authorization || !Credential.extractPaymentScheme(authorization)) return null;

  try {
    const credential = Credential.fromRequest(request);
    const recipient = credential.challenge.request.recipient;
    return typeof recipient === "string" && recipient.startsWith("0x") ? recipient : null;
  } catch {
    throw new InvalidStripeMppCredentialError();
  }
};

const createPayToAddress = async (request: Request, client: Stripe) => {
  prunePaymentCache();

  const credentialRecipient = getPayToAddressFromCredential(request);
  if (credentialRecipient) {
    const cached = paymentCache.get(credentialRecipient);
    if (!cached)
      throw new Error("Invalid Stripe MPP recipient: not found in the active payment cache.");
    return {
      recipient: credentialRecipient as `0x${string}`,
      paymentIntentId: cached.paymentIntentId,
    };
  }

  const paymentIntent = await client.paymentIntents.create({
    amount: Number(amount) * 100,
    currency,
    payment_method_types: ["crypto"],
    payment_method_data: { type: "crypto" },
    payment_method_options: {
      crypto: {
        mode: "deposit",
        deposit_options: { networks: ["tempo"] },
      } as Stripe.PaymentIntentCreateParams.PaymentMethodOptions.Crypto,
    },
    confirm: true,
  });

  if (!paymentIntent.next_action || !("crypto_display_details" in paymentIntent.next_action)) {
    throw new Error("Stripe PaymentIntent did not return Tempo deposit details.");
  }

  const depositDetails = paymentIntent.next_action.crypto_display_details as unknown as {
    deposit_addresses?: Record<string, { address?: string }>;
  };
  const recipient = depositDetails.deposit_addresses?.tempo?.address;

  if (!recipient) throw new Error("Stripe PaymentIntent did not return a Tempo deposit address.");

  paymentCache.set(recipient, {
    paymentIntentId: paymentIntent.id,
    expiresAt: Date.now() + paymentCacheTtlMs,
  });

  return { recipient: recipient as `0x${string}`, paymentIntentId: paymentIntent.id };
};

export const handleStripeMppPaidShowcase = (request: Request) =>
  flovia.trackPaidApi(request, {
    provider,
    rail,
    endpoint,
    amount,
    currency,
    handler: async ({ requestId, attachPaymentContext }) => {
      const config = resolveStripeShowcaseConfig();

      if (!config) {
        return json(
          {
            error: "stripe_mpp_not_configured",
            message: "Set STRIPE_SECRET_KEY to enable the real Stripe MPP live showcase flow.",
            requiredEnv: ["STRIPE_SECRET_KEY"],
            optionalEnv: ["MPP_SECRET_KEY"],
            floviaEvent: {
              status: "configuration_required",
              responseStatus: 503,
              payment: { provider, rail, amount, currency },
              joinedInsight:
                "Live Stripe MPP requires Stripe preview credentials before Flovia can join real Tempo payment context.",
            },
          },
          { status: 503 },
        );
      }

      let recipient: `0x${string}`;
      let paymentIntentId: string;

      try {
        ({ recipient, paymentIntentId } = await createPayToAddress(request, config.client));
      } catch (error) {
        if (!(error instanceof InvalidStripeMppCredentialError)) throw error;
        return json(
          {
            error: "invalid_stripe_mpp_credential",
            message:
              "Retry with a valid MPP Payment credential issued for this Stripe Tempo challenge.",
            floviaEvent: {
              status: "credential_rejected",
              responseStatus: 400,
              payment: { provider, rail, amount, currency },
              joinedInsight:
                "Flovia rejected a malformed Stripe MPP credential before creating a new PaymentIntent.",
            },
          },
          { status: 400 },
        );
      }

      attachPaymentContext({
        provider,
        rail,
        paymentIntentId,
        recipient,
        network: "tempo",
        amount,
        currency,
      });

      const mppx = ServerMppx.create({
        methods: [tempo.charge({ currency: pathUsd, recipient, testnet: true })],
        secretKey: config.mppSecretKey,
      });

      const response = await mppx.compose([
        mppx.tempo.charge,
        { amount, decimals: tempoDecimals, recipient },
      ])(request);

      if (response.status === 402) return response.challenge;

      paymentCache.delete(recipient);

      return response.withReceipt(
        Response.json({
          ok: true,
          foo: "bar",
          provider,
          paidApi: {
            endpoint,
            message: "Stripe MPP showcase paid response",
            generatedAt: new Date().toISOString(),
          },
          floviaEvent: {
            requestId,
            provider,
            rail,
            endpoint,
            method: request.method,
            responseStatus: 200,
            status: "paid_api_delivered",
            payment: { paymentIntentId, recipient, network: "tempo", amount, currency },
            apiUsage: { endpoint, method: request.method, responseStatus: 200 },
            joinedInsight: "Stripe Tempo payment context converted into retained paid API demand.",
          },
        }),
      );
    },
  });
