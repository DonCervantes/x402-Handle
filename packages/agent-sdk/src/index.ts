// Ticket 5.8 — @flovia/agent-sdk. Cliente para agentes: descubre providers en
// el registry Stellar (vía el BFF), los rankea con el Trust Score
// determinístico, y paga + consume directo contra el endpoint del provider
// usando x402-stellar (sin pasar por el BFF para el pago — el agente firma
// con su propio secret).
//
// El pago está *bound* al registry: el destino que el agente firma es el
// `ownerAccount` que el registry declara para el provider, nunca el
// `destination` que devuelva el endpoint (issue #11).
import type { StellarProvider } from "contracts";
import { x402Pay } from "@flovia/x402-stellar/client";
import { assertPaymentEndpointAllowed, registryPaymentAccount } from "./policy";
import type {
  DiscoverAndCallOpts,
  DiscoverAndCallResult,
  FloviaOpts,
  RankedStellarProvider,
  RecommendOpts,
} from "./types";

export type {
  DiscoverAndCallOpts,
  DiscoverAndCallResult,
  FloviaOpts,
  RankedStellarProvider,
  RecommendOpts,
} from "./types";
export { assertPaymentEndpointAllowed, matchesHost, registryPaymentAccount } from "./policy";
export type { EndpointPolicy } from "./policy";

const DEFAULT_BFF_URL = "http://localhost:3001";

export class Flovia {
  private readonly secret: string;
  private readonly network: "testnet" | "public";
  private readonly bffUrl: string;
  private readonly maxAmountUsdc?: number;
  private readonly allowedHosts: readonly string[];
  private readonly allowInsecureEndpoint: boolean;

  constructor(opts: FloviaOpts) {
    if (!opts.secret) throw new Error("Flovia: missing 'secret' (agent Stellar seed, S...)");
    this.secret = opts.secret;
    this.network = opts.network ?? "testnet";
    this.bffUrl = (opts.bffUrl ?? DEFAULT_BFF_URL).replace(/\/$/, "");
    this.maxAmountUsdc = opts.maxAmountUsdc;
    this.allowedHosts = opts.allowedHosts ?? [];
    this.allowInsecureEndpoint = opts.allowInsecureEndpoint ?? false;
  }

  /** Catálogo completo de providers registrados en el registry Soroban. */
  async discover(): Promise<StellarProvider[]> {
    const res = await fetch(`${this.bffUrl}/stellar/providers`);
    if (!res.ok) throw new Error(`Flovia.discover: BFF respondió ${res.status}`);
    return (await res.json()) as StellarProvider[];
  }

  /** Providers rankeados por Trust Score + precio + categoría (determinístico, no IA). */
  async recommend(opts: RecommendOpts = {}): Promise<RankedStellarProvider[]> {
    const params = new URLSearchParams();
    if (opts.category) params.set("category", opts.category);
    if (opts.maxPriceUsdc !== undefined) params.set("maxPriceUsdc", String(opts.maxPriceUsdc));
    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${this.bffUrl}/stellar/recommend${query}`);
    if (!res.ok) throw new Error(`Flovia.recommend: BFF respondió ${res.status}`);
    return (await res.json()) as RankedStellarProvider[];
  }

  /**
   * Paga (x402-stellar, firmado con `secret`) y consume el endpoint del provider directamente.
   *
   * El pago sólo se firma si el challenge del endpoint apunta a la cuenta que
   * el registry declara como owner del provider: el `destination` del 402 se
   * compara contra `provider.ownerAccount` y un mismatch aborta antes de firmar.
   */
  async pay(
    provider: StellarProvider,
    payload?: Record<string, unknown>,
  ): Promise<DiscoverAndCallResult["payment"] & { data: unknown; elapsedMs: number }> {
    const endpoint = assertPaymentEndpointAllowed(provider.endpoint, {
      allowedHosts: this.allowedHosts,
      allowInsecure: this.allowInsecureEndpoint,
    });
    const registryAccount = registryPaymentAccount(provider);

    const url = endpoint;
    for (const [key, value] of Object.entries(payload ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const result = await x402Pay({
      url: url.toString(),
      agentSecret: this.secret,
      network: this.network,
      maxAmountUsdc: this.maxAmountUsdc,
      expectedDestination: registryAccount,
    });
    if (result.response.status !== 200) {
      throw new Error(
        `Flovia.pay: el provider respondió ${result.response.status} tras el pago x402`,
      );
    }
    return {
      txHash: result.payment.txHash,
      amountUsdc: result.payment.amount,
      memo: result.payment.memo,
      data: result.data,
      elapsedMs: result.elapsedMs,
    };
  }

  /**
   * Descubre, recomienda, paga y consume en una sola llamada — el entry
   * point principal para un agente que solo necesita "dame el mejor resultado
   * para esta necesidad, ya pagado".
   */
  async discoverAndCall(opts: DiscoverAndCallOpts): Promise<DiscoverAndCallResult> {
    const ranked = await this.recommend({ category: opts.need, maxPriceUsdc: opts.maxPrice });
    const top = ranked[0];
    if (!top) {
      throw new Error(`Flovia.discoverAndCall: no se encontró provider para need="${opts.need}"`);
    }
    const paid = await this.pay(top.provider, opts.payload);
    return {
      provider: top.provider,
      data: paid.data,
      payment: { txHash: paid.txHash, amountUsdc: paid.amountUsdc, memo: paid.memo },
      elapsedMs: paid.elapsedMs,
    };
  }
}
