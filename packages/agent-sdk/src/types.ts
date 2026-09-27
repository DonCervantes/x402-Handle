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
  /**
   * Allowlist de hosts de provider aceptados. Sólo los endpoints cuyo host
   * matchee alguna entrada pueden pagarse (comodines de subdominio:
   * `*.example.com`). Default: sin restricción de host, pero siempre HTTPS.
   */
  allowedHosts?: readonly string[];
  /**
   * Permite endpoints `http://`. Default `false`: un endpoint en claro puede
   * ser reescrito en la ruta y desviar el pago. Usar sólo en desarrollo local.
   */
  allowInsecureEndpoint?: boolean;
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
