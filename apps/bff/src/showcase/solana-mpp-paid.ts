import { createKeyPairSignerFromBytes } from "@solana/kit";
import { Mppx as ClientMppx, solana as clientSolana } from "@solana/mpp/client";
import { Mppx, solana } from "@solana/mpp/server";
import { flovia, json } from "./flovia-track-paid-api";

const endpoint = "/showcase/solana-mpp/paid";
const payEndpoint = "/showcase/solana-mpp/pay";
const provider = "solana" as const;
const rail = "mpp" as const;
const PAY_CONFIRMATION_HEADER = "x-flovia-showcase-pay";
const PAY_CONFIRMATION_VALUE = "solana-mpp";

// Display amount (UI/Flovia event metadata).
const displayAmount = "0.10";
const displayCurrency = "usdc";

// Protocol-level values handed to `mppx.charge({...})`. These must match the
// Solana MPP SPL token mint and baseunit amount, not the display strings above.
const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const decimals = 6;
const baseUnitsAmount = toBaseUnits(displayAmount, decimals);

const ALLOWED_NETWORKS = ["devnet", "localnet", "mainnet-beta"] as const;
type SolanaNetwork = (typeof ALLOWED_NETWORKS)[number];

function toBaseUnits(amount: string, dec: number): string {
  const [whole, fraction = ""] = amount.split(".");
  if (whole === undefined || /[^0-9]/.test(whole) || /[^0-9]/.test(fraction)) {
    throw new Error(`Invalid Solana MPP amount: ${amount}`);
  }
  const padded = (fraction + "0".repeat(dec)).slice(0, dec);
  const combined = `\( {whole} \){padded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

function resolveNetwork(): SolanaNetwork {
  const raw = envValue("SOLANA_MPP_NETWORK");
  if (!raw) return "devnet";
  if ((ALLOWED_NETWORKS as readonly string[]).includes(raw)) return raw as SolanaNetwork;
  throw new Error(
    `Invalid SOLANA_MPP_NETWORK="${raw}". Expected one of: ${ALLOWED_NETWORKS.join(", ")}.`,
  );
}

const envValue = (key: string) => {
  const value = process.env[key]?.trim();
  return value ? value : null;
};

const buildSolanaMppx = (recipient: string, network: SolanaNetwork, secretKey: string) => {
  const mint = envValue("SOLANA_MPP_CURRENCY") ?? USDC_DEVNET_MINT;
  const rpcUrl = envValue("SOLANA_MPP_RPC_URL");
  return Mppx.create({
    secretKey,
    methods: [
      solana.charge({
        recipient,
        currency: mint,
        decimals,
        network,
        ...(rpcUrl ? { rpcUrl } : {}),
      }),
    ],
  });
};

let cachedMppx: ReturnType<typeof buildSolanaMppx> | null = null;
let cachedRecipient: string | null = null;
let cachedNetwork: SolanaNetwork | null = null;
let cachedRpcUrl: string | null = null;

type SolanaMppResolved =
  | { ok: true; mppx: ReturnType<typeof buildSolanaMppx>; recipient: string }
  | { ok: false; reason: "missing_recipient" | "missing_secret" };

const resolveSolanaMppx = (network: SolanaNetwork): SolanaMppResolved => {
  const recipient = envValue("SOLANA_MPP_RECIPIENT");
  if (!recipient) return { ok: false, reason: "missing_recipient" };

  // Fail closed: never generate an ephemeral secret at runtime (#72).
  const secretKey = envValue("SOLANA_MPP_SECRET_KEY");
  if (!secretKey) return { ok: false, reason: "missing_secret" };

  const rpcUrl = envValue("SOLANA_MPP_RPC_URL");
  if (
    cachedMppx &&
    cachedRecipient === recipient &&
    cachedNetwork === network &&
    cachedRpcUrl === rpcUrl
  ) {
    return { ok: true, mppx: cachedMppx, recipient };
  }
  cachedMppx = buildSolanaMppx(recipient, network, secretKey);
  cachedRecipient = recipient;
  cachedNetwork = network;
  cachedRpcUrl = rpcUrl;
  return { ok: true, mppx: cachedMppx, recipient };
};

export const handleSolanaMppPaidShowcase = (request: Request) =>
  flovia.trackPaidApi(request, {
    provider,
    rail,
    endpoint,
    amount: displayAmount,
    currency: displayCurrency,
    handler: async ({ requestId, attachPaymentContext }) => {
      let network: SolanaNetwork;
      try {
        network = resolveNetwork();
      } catch (error) {
        return json(
          {
            error: "solana_mpp_invalid_network",
            message: error instanceof Error ? error.message : "Invalid SOLANA_MPP_NETWORK value.",
            allowedEnv: { SOLANA_MPP_NETWORK: ALLOWED_NETWORKS },
            floviaEvent: {
              status: "configuration_invalid",
              responseStatus: 503,
              payment: { provider, rail, amount: displayAmount, currency: displayCurrency },
              joinedInsight:
                "Solana MPP showcase rejected an unknown network value before reaching the broker.",
            },
          },
          { status: 503 },
        );
      }

      const resolved = resolveSolanaMppx(network);

      if (!resolved.ok && resolved.reason === "missing_secret") {
        return json(
          {
            error: "solana_mpp_secret_required",
            message:
              "Set SOLANA_MPP_SECRET_KEY to a stable server secret. The showcase does not generate secrets at runtime.",
            requiredEnv: ["SOLANA_MPP_SECRET_KEY", "SOLANA_MPP_RECIPIENT"],
            optionalEnv: ["SOLANA_MPP_NETWORK", "SOLANA_MPP_CURRENCY", "SOLANA_MPP_RPC_URL"],
            floviaEvent: {
              status: "configuration_required",
              responseStatus: 503,
              payment: {
                provider,
                rail,
                network: `solana-${network}`,
                amount: displayAmount,
                currency: displayCurrency,
              },
              joinedInsight:
                "Solana MPP showcase fails closed when SOLANA_MPP_SECRET_KEY is unset (no ephemeral random secret).",
            },
          },
          { status: 503 },
        );
      }

      if (!resolved.ok) {
        return json(
          {
            error: "solana_mpp_not_configured",
            message: `Set SOLANA_MPP_RECIPIENT to enable the real Solana MPP showcase flow on ${network}.`,
            requiredEnv: ["SOLANA_MPP_RECIPIENT", "SOLANA_MPP_SECRET_KEY"],
            optionalEnv: ["SOLANA_MPP_NETWORK", "SOLANA_MPP_CURRENCY", "SOLANA_MPP_RPC_URL"],
            floviaEvent: {
              status: "configuration_required",
              responseStatus: 503,
              payment: {
                provider,
                rail,
                network: `solana-${network}`,
                amount: displayAmount,
                currency: displayCurrency,
              },
              joinedInsight: `Live Solana MPP requires a ${network} recipient before Flovia can join real Solana payment context.`,
            },
          },
          { status: 503 },
        );
      }

      const mint = envValue("SOLANA_MPP_CURRENCY") ?? USDC_DEVNET_MINT;
      const result = await resolved.mppx.solana.charge({
        amount: baseUnitsAmount,
        currency: mint,
      })(request);

      if (result.status === 402) return result.challenge;

      // For Solana, the per-payment identifier is the on-chain transaction
      // signature, which the MPP receipt header carries. The frontend reads
      // it from the receipt and surfaces it in both the "Tx signature" and
      // "Payment id" rows so we do not need to invent a server-side id here.
      attachPaymentContext({
        provider,
        rail,
        network: `solana-${network}`,
        amount: displayAmount,
        currency: displayCurrency,
        mint,
        recipient: resolved.recipient,
      });

      return result.withReceipt(
        Response.json({
          ok: true,
          foo: "bar",
          provider,
          paidApi: {
            endpoint,
            message: "Solana MPP showcase paid response",
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
            payment: {
              provider,
              rail,
              network: `solana-${network}`,
              amount: displayAmount,
              currency: displayCurrency,
              mint,
              recipient: resolved.recipient,
            },
            apiUsage: { endpoint, method: request.method, responseStatus: 200 },
            joinedInsight:
              "Solana SPL token payment context converted into retained paid API demand.",
          },
        }),
      );
    },
  });

// ---- Pay-button handler ---------------------------------------------------
//
// The pay route mirrors Stripe's `/showcase/stripe-mpp/pay`: it spins up a
// Solana MPP client wallet (using a server-side payer keypair) and lets it
// pay-then-retry the local `/showcase/solana-mpp/paid` route. The frontend
// posts to this endpoint when the user clicks "Pay with Solana wallet" so
// the showcase can complete an end-to-end live flow without a browser
// wallet extension.

const SECRET_KEY_BYTES = 64;

class InvalidSolanaPayerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSolanaPayerKeyError";
  }
}

function decodeBase58(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) {
    map.set(alphabet[i] as string, i);
  }
  let leadingZeros = 0;
  for (const char of value) {
    if (char === "1") leadingZeros++;
    else break;
  }
  let num = 0n;
  for (const char of value) {
    const digit = map.get(char);
    if (digit === undefined) {
      throw new InvalidSolanaPayerKeyError(`Invalid base58 character: ${char}`);
    }
    num = num * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  bytes.reverse();
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[leadingZeros + i] = bytes[i] as number;
  }
  return out;
}

function parsePayerSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  // 1) Solana CLI keypair format (JSON array of 64 numbers).
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new InvalidSolanaPayerKeyError("SOLANA_MPP_PAYER_PRIVATE_KEY is not valid JSON.");
    }
    if (!Array.isArray(parsed) || parsed.length !== SECRET_KEY_BYTES) {
      throw new InvalidSolanaPayerKeyError(
        `SOLANA_MPP_PAYER_PRIVATE_KEY JSON must be an array of ${SECRET_KEY_BYTES} bytes.`,
      );
    }
    const bytes = new Uint8Array(SECRET_KEY_BYTES);
    for (let i = 0; i < SECRET_KEY_BYTES; i++) {
      const value = parsed[i];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new InvalidSolanaPayerKeyError(
          `SOLANA_MPP_PAYER_PRIVATE_KEY byte ${i} must be an integer in [0, 255].`,
        );
      }
      bytes[i] = value;
    }
    return bytes;
  }
  // 2) Base58-encoded 64-byte secret key (Phantom/Backpack export format).
  const decoded = decodeBase58(trimmed);
  if (decoded.length !== SECRET_KEY_BYTES) {
    throw new InvalidSolanaPayerKeyError(
      `SOLANA_MPP_PAYER_PRIVATE_KEY must decode to ${SECRET_KEY_BYTES} bytes (got ${decoded.length}). Provide the Solana CLI JSON array or a base58-encoded 64-byte secret key.`,
    );
  }
  return decoded;
}

let cachedPayerSigner: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>> | null = null;
let cachedPayerKeySource: string | null = null;

async function resolveSolanaPayerSigner() {
  const raw = envValue("SOLANA_MPP_PAYER_PRIVATE_KEY");
  if (!raw) return null;
  if (cachedPayerSigner && cachedPayerKeySource === raw) return cachedPayerSigner;
  const bytes = parsePayerSecretKey(raw);
  cachedPayerSigner = await createKeyPairSignerFromBytes(bytes);
  cachedPayerKeySource = raw;
  return cachedPayerSigner;
}

export const handleSolanaMppPayShowcase = async (request: Request) => {
  if (
    request.method !== "POST" ||
    request.headers.get(PAY_CONFIRMATION_HEADER) !== PAY_CONFIRMATION_VALUE
  ) {
    return json(
      {
        error: "solana_mpp_pay_confirmation_required",
        message: "Solana MPP demo wallet payments require a POST request from the showcase UI.",
      },
      { status: 400 },
    );
  }

  let signer: Awaited<ReturnType<typeof resolveSolanaPayerSigner>>;
  try {
    signer = await resolveSolanaPayerSigner();
  } catch (error) {
    if (!(error instanceof InvalidSolanaPayerKeyError)) throw error;
    return json(
      {
        error: "solana_mpp_payer_invalid",
        message: error.message,
        requiredEnv: ["SOLANA_MPP_PAYER_PRIVATE_KEY"],
      },
      { status: 503 },
    );
  }

  if (!signer) {
    return json(
      {
        error: "solana_mpp_payer_not_configured",
        message:
          "Set SOLANA_MPP_PAYER_PRIVATE_KEY (Solana CLI JSON array or base58-encoded 64-byte secret key) to pay from the showcase button.",
        requiredEnv: ["SOLANA_MPP_PAYER_PRIVATE_KEY"],
      },
      { status: 503 },
    );
  }

  try {
    const rpcUrl = envValue("SOLANA_MPP_RPC_URL");
    const mppx = ClientMppx.create({
      methods: [clientSolana.charge({ signer, broadcast: true, ...(rpcUrl ? { rpcUrl } : {}) })],
      polyfill: false,
      fetch: ((input, init) => {
        const paidRequest = new Request(input, init);
        return handleSolanaMppPaidShowcase(paidRequest);
      }) as typeof globalThis.fetch,
    });

    const response = await mppx.fetch(new URL(endpoint, request.url), {
      headers: { accept: "application/json" },
    });

    // The /pay abstraction is "pay on the server, return the paid response or
    // a clear failure". A 402 *after* the server has already attempted to pay
    // means the on-chain transaction the payer signed could not be verified
    // (typically: payer wallet unfunded or missing the destination ATA).
    // Surface that as a payment failure rather than passing the 402 through,
    // which the UI would otherwise render as a fresh payment challenge.
    if (response.status === 402) {
      return convertPostPay402ToFailure(response, signer.address);
    }

    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set(PAY_CONFIRMATION_HEADER, PAY_CONFIRMATION_VALUE);
    headers.set("x-flovia-solana-payer", signer.address);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    return json(
      {
        error: "solana_mpp_payment_failed",
        message:
          error instanceof Error && error.message ? error.message : "Solana MPP payment failed.",
        paidApi: { endpoint, payEndpoint },
        payer: signer.address,
        hint: "The payer wallet must hold devnet SOL (for fees) and devnet USDC (for the SPL transfer). Fund it via https://faucet.solana.com and https://faucet.circle.com.",
      },
      { status: 502 },
    );
  }
};

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Wraps an upstream 402 returned from the local paid handler *after* the
 * server-side payer has already attempted to pay. The /pay route's
 * abstraction is "pay on the server, return the paid response or a clear
 * failure"; passing a raw 402 through would leak the internal retry stage
 * to the UI as a fresh challenge.
 *
 * Exported so the regression test can lock in the conversion shape without
 * needing live devnet RPC.
 */
export async function convertPostPay402ToFailure(
  response: Response,
  payerAddress: string,
): Promise<Response> {
  const upstreamBody = await response.text();
  return json(
    {
      error: "solana_mpp_payment_failed",
      message:
        "Solana MPP server-side payer attempted the SPL transfer, but the transaction could not be verified on devnet. The payer wallet most likely lacks devnet SOL (for fees) or devnet USDC (for the transfer).",
      paidApi: { endpoint, payEndpoint },
      payer: payerAddress,
      hint: "Fund the payer wallet via https://faucet.solana.com (devnet SOL) and https://faucet.circle.com (devnet USDC), then retry.",
      upstream: { status: 402, body: safeJsonParse(upstreamBody) ?? upstreamBody },
    },
    { status: 502 },
  );
    }
