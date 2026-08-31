// Ticket 5.6 — paso "pay & consume" del playground. Ejecuta x402Pay()
// server-side: la secret key del agente demo (DEMO_AGENT_SECRET) nunca debe
// llegar al browser. Solo el provider 1 (FX Rates Oracle) tiene un endpoint
// HTTP real corriendo (apps/demo-provider); los otros 4 seeds son catálogo
// demo con endpoints de ejemplo (fx.example.com, etc.), no HTTP real — para
// esos, devolvemos un error explícito en vez de intentar un fetch que sabemos
// que va a fallar.
import { x402Pay } from "@flovia/x402-stellar/client";
import { loadStellarNetworkConfig } from "contracts";
import { getStellarProviderById } from "./stellar-providers";

const LIVE_DEMO_PROVIDER_ID = 1;

export type PlaygroundPayResult =
  | {
      ok: true;
      txHash: string;
      amountUsdc: string;
      memo: string;
      elapsedMs: number;
      data: unknown;
    }
  | { ok: false; error: "not_found" | "no_live_endpoint" | "misconfigured" | "payment_failed"; message: string };

export async function runPlaygroundPayment(stellarProviderId: string): Promise<PlaygroundPayResult> {
  const provider = await getStellarProviderById(stellarProviderId);
  if (!provider) {
    return { ok: false, error: "not_found", message: "Provider no encontrado en el registry." };
  }

  if (provider.providerId !== LIVE_DEMO_PROVIDER_ID) {
    return {
      ok: false,
      error: "no_live_endpoint",
      message:
        `${provider.name} es un provider de catálogo demo (endpoint de ejemplo, no HTTP real). ` +
        "Solo FX Rates Oracle tiene el flujo x402 completo cableado en este hackathon.",
    };
  }

  const agentSecret = process.env.DEMO_AGENT_SECRET;
  if (!agentSecret) {
    return {
      ok: false,
      error: "misconfigured",
      message: "DEMO_AGENT_SECRET no está configurado en el BFF.",
    };
  }

  const providerUrl = `http://localhost:${process.env.DEMO_PROVIDER_PORT ?? 5402}`;
  const { network } = loadStellarNetworkConfig();

  try {
    const result = await x402Pay({
      url: `${providerUrl}/api/rate?pair=EUR/USD`,
      agentSecret,
      network,
      maxAmountUsdc: 0.01,
    });

    if (result.response.status !== 200) {
      return {
        ok: false,
        error: "payment_failed",
        message: `El provider respondió ${result.response.status} tras el pago.`,
      };
    }

    return {
      ok: true,
      txHash: result.payment.txHash,
      amountUsdc: result.payment.amount,
      memo: result.payment.memo,
      elapsedMs: result.elapsedMs,
      data: result.data,
    };
  } catch (error) {
    return {
      ok: false,
      error: "payment_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
