import type { StellarProvider } from "contracts";

export type RankedStellarProvider = {
  provider: StellarProvider;
  trustScore: number;
  matchScore: number;
  reasons: string[];
};

export type FloviaOpts = {
  /** Secret seed (S...) del agente que paga. */
  secret: string;
  network?: "testnet" | "public";
  /** Base URL del BFF de Flovia (discovery + recomendación). Default: testnet hosted BFF. */
  bffUrl?: string;
  /** Máximo monto USDC por call que el SDK aceptará pagar sin pedir confirmación explícita. */
  maxAmountUsdc?: number;
  /** Máximo monto USDC acumulado por día (UTC) que el SDK aceptará pagar. */
  dailyCapUsdc?: number;
  /** Reloj inyectable (epoch ms) para la ventana diaria de gasto. Default: Date.now. */
  now?: () => number;
};

export type RecommendOpts = {
  category?: string;
  maxPriceUsdc?: number;
};

export type DiscoverAndCallOpts = {
  /** Categoría/necesidad buscada (ej. "fx-rates", "fx", "data"). */
  need: string;
  maxPrice?: number;
  /** Si true, descarta candidatos no recomendados aún si matchean — el ranker ya pondera KYB vía Trust Score; este flag es informativo para callers que quieran filtrar ellos mismos. */
  kybRequired?: boolean;
  /** Query params/body a enviar al endpoint del provider tras pagar. */
  payload?: Record<string, unknown>;
};

export type DiscoverAndCallResult = {
  provider: StellarProvider;
  data: unknown;
  payment: { txHash: string; amountUsdc: string; memo: string };
  elapsedMs: number;
};
