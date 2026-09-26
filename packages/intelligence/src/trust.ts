// Ticket 4.1 — Trust Score, fórmula determinística (TRD § 7 de docs/FLOVIA-STELLAR.md):
//
//   TrustScore = w1·age + w2·volume + w3·kyb + w4·claims + w5·recency
//
//   age      = min(1, days_since_registered / 90)        w1 = 0.15
//   volume   = min(1, log10(usdc_volume_30d + 1) / 4)     w2 = 0.30
//   kyb      = 1.0 verified, 0.3 pending, 0 none          w3 = 0.30
//   claims   = 1 - min(1, disputes / payments)            w4 = 0.15
//   recency  = 1.0 si activo en 7d, 0.5 si 30d, 0 si más  w5 = 0.10
//
//   Score final = round(100 · sum(pesos · factores))
import type { KybStatus, TrustScore, TrustScoreComponents } from "contracts";

export const TRUST_SCORE_WEIGHTS = {
  age: 0.15,
  volume: 0.3,
  kyb: 0.3,
  claims: 0.15,
  recency: 0.1,
} as const;

export interface TrustScoreInput {
  /** Fecha de registro del provider on-chain (created_at). */
  registeredAt: Date;
  /** Volumen total en USDC pagado al provider en los últimos 30 días. */
  volume30dUsdc: number;
  kybStatus: KybStatus;
  /** Disputas/incidentes reportados sobre el provider (lifetime). */
  disputeCount: number;
  /** Pagos totales recibidos por el provider (lifetime, ≥ disputeCount). */
  paymentCount: number;
  /** Última vez que el provider tuvo un pago exitoso, o null si nunca. */
  lastPaymentAt: Date | null;
  /** Reloj inyectable para tests deterministas. */
  now?: Date;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function ageFactor(registeredAt: Date, now: Date): number {
  const daysSince = (now.getTime() - registeredAt.getTime()) / (1000 * 60 * 60 * 24);
  return clamp01(daysSince / 90);
}

export function volumeFactor(volume30dUsdc: number): number {
  const safeVolume = Math.max(0, volume30dUsdc);
  return clamp01(Math.log10(safeVolume + 1) / 4);
}

export function kybFactor(status: KybStatus): number {
  if (status === "verified") return 1.0;
  if (status === "demo_verified" || status === "pending") return 0.3;
  return 0;
}

export function claimsFactor(disputeCount: number, paymentCount: number): number {
  if (paymentCount <= 0) return 0; // sin historial de pagos, sin señal (ni positiva ni negativa)
  return clamp01(1 - Math.min(1, disputeCount / paymentCount));
}

export function recencyFactor(lastPaymentAt: Date | null, now: Date): number {
  if (!lastPaymentAt) return 0;
  const daysSince = (now.getTime() - lastPaymentAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 7) return 1.0;
  if (daysSince <= 30) return 0.5;
  return 0;
}

export function computeTrustScore(input: TrustScoreInput): TrustScore {
  const now = input.now ?? new Date();

  const components: TrustScoreComponents = {
    age: ageFactor(input.registeredAt, now),
    volume: volumeFactor(input.volume30dUsdc),
    kyb: kybFactor(input.kybStatus),
    claims: claimsFactor(input.disputeCount, input.paymentCount),
    recency: recencyFactor(input.lastPaymentAt, now),
  };

  const weightedSum =
    TRUST_SCORE_WEIGHTS.age * components.age +
    TRUST_SCORE_WEIGHTS.volume * components.volume +
    TRUST_SCORE_WEIGHTS.kyb * components.kyb +
    TRUST_SCORE_WEIGHTS.claims * components.claims +
    TRUST_SCORE_WEIGHTS.recency * components.recency;

  return {
    score: Math.round(100 * weightedSum),
    components,
    weights: TRUST_SCORE_WEIGHTS,
    computedAt: now.toISOString(),
  };
}
