// code/x402-stellar-middleware/src/types.ts
import { z } from "zod";

export const X402_VERSION = "x402-stellar-1";

/**
 * Challenge enviado en el body de un 402 response.
 */
export const X402ChallengeSchema = z.object({
  version: z.literal(X402_VERSION),
  network: z.enum(["testnet", "public"]),
  asset: z.object({
    code: z.literal("USDC"),
    issuer: z.string().regex(/^G[A-Z2-7]{55}$/),
  }),
  amount: z.string(),                          // "0.005" — formato Stellar
  destination: z.string().regex(/^G[A-Z2-7]{55}$/),
  memo: z.string().min(1).max(28),             // memo Stellar (28 bytes max)
  expires_at: z.string().datetime(),
});
export type X402Challenge = z.infer<typeof X402ChallengeSchema>;

/**
 * Configuración del middleware en el servidor.
 */
export interface X402ServerConfig {
  destination: string;                          // G... cuenta del proveedor
  amountUsdc: string;                           // "0.005"
  network: "testnet" | "public";
  horizonUrl?: string;                          // default per network
  usdcIssuer?: string;                          // default per network
  challengeTtlSec?: number;                     // default 300 (5 min)
  /**
   * Llamado después de verificar exitosamente. Útil para registrar
   * el pago en el contrato Soroban o en una DB local.
   */
  onPaymentVerified?: (info: {
    txHash: string;
    payer: string;
    amount: string;
    memo: string;
  }) => Promise<void> | void;
  /**
   * Optional settlement gate awaited after the payment is verified and its
   * hash claimed, but before the resource is served. If it throws, the
   * request gets 402 `settlement_failed` and the hash stays consumed.
   * Wire it to logPaymentOnChain to require the Soroban registry's
   * TxConsumed entry (duplicates panic with PaymentAlreadyLogged).
   */
  settlePayment?: (info: {
    txHash: string;
    payer: string;
    amount: string;
    memo: string;
  }) => Promise<void>;
  /**
   * Si está presente, el middleware sólo acepta requests cuyo path
   * matchee este pattern (regex). Útil para mezclar endpoints pagos y libres.
   */
  pathPattern?: RegExp;
}

/**
 * Razones por las que un X-PAYMENT no se acepta.
 */
export type VerifyFailureReason =
  | "missing_header"
  | "tx_not_found"
  | "tx_failed"
  | "memo_mismatch"
  | "destination_mismatch"
  | "asset_mismatch"
  | "underpayment"
  | "already_consumed"
  | "challenge_expired"
  | "horizon_error";

export type VerifyResult =
  | { ok: true; payer: string; amount: string; txHash: string; memo: string }
  | { ok: false; reason: VerifyFailureReason; detail?: string };
