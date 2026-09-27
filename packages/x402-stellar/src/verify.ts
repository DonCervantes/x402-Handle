// code/x402-stellar-middleware/src/verify.ts
//
// Verificación on-chain de un pago x402-Stellar.
// Consulta Horizon (única fuente de verdad) y valida cada campo
// contra el challenge esperado.

import { Horizon } from "@stellar/stellar-sdk";
import { isUsdcAmount, meetsUsdcAmount, parseUsdcToStroops } from "./amount";
import type { VerifyResult, X402Challenge } from "./types";

const HORIZON_URLS = {
  testnet: "https://horizon-testnet.stellar.org",
  public:  "https://horizon.stellar.org",
};

const USDC_ISSUERS = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  public:  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

export interface VerifyOpts {
  txHash: string;
  expected: {
    destination: string;
    amountUsdc: string;          // "0.005"
    memo: string;
    network: "testnet" | "public";
    usdcIssuer?: string;         // override opcional
  };
  horizonUrl?: string;           // override opcional
}

/**
 * Devuelve { ok: true, ... } si y sólo si:
 *   - la tx existe en Horizon
 *   - es exitosa
 *   - su memo coincide con el challenge
 *   - tiene una payment op con destino, asset (USDC + issuer correcto), y monto >= esperado
 *   - el monto está dentro de la tolerancia (default: igual o mayor)
 *
 * NUNCA confía en el cliente: todo se valida contra Horizon.
 */
export async function verifyUsdcPayment(opts: VerifyOpts): Promise<VerifyResult> {
  // Fail loudly on a misconfigured price rather than comparing against NaN.
  parseUsdcToStroops(opts.expected.amountUsdc);
  const horizonUrl = opts.horizonUrl ?? HORIZON_URLS[opts.expected.network];
  const expectedIssuer = opts.expected.usdcIssuer ?? USDC_ISSUERS[opts.expected.network];
  const server = new Horizon.Server(horizonUrl);

  let tx: any;
  try {
    tx = await server.transactions().transaction(opts.txHash).call();
  } catch (err: any) {
    if (err?.response?.status === 404) {
      return { ok: false, reason: "tx_not_found" };
    }
    return { ok: false, reason: "horizon_error", detail: String(err?.message ?? err) };
  }

  if (!tx.successful) {
    return { ok: false, reason: "tx_failed" };
  }

  // Memo: Horizon devuelve memo_type ("text", "id", "hash", "return", "none")
  // Para x402 usamos memo_type === "text".
  if (tx.memo_type !== "text" || tx.memo !== opts.expected.memo) {
    return {
      ok: false,
      reason: "memo_mismatch",
      detail: `expected memo "${opts.expected.memo}", got "${tx.memo}" (type=${tx.memo_type})`,
    };
  }

  // Operations
  let opsPage: any;
  try {
    opsPage = await server.operations().forTransaction(opts.txHash).call();
  } catch (err: any) {
    return { ok: false, reason: "horizon_error", detail: String(err?.message ?? err) };
  }

  const payment = opsPage.records.find(
    (o: any) => o.type === "payment" || o.type === "path_payment_strict_send" || o.type === "path_payment_strict_receive"
  );
  if (!payment) {
    return { ok: false, reason: "horizon_error", detail: "no payment operation in transaction" };
  }

  if (payment.to !== opts.expected.destination) {
    return {
      ok: false,
      reason: "destination_mismatch",
      detail: `expected ${opts.expected.destination}, got ${payment.to}`,
    };
  }

  if (payment.asset_type === "native") {
    return { ok: false, reason: "asset_mismatch", detail: "got XLM, expected USDC" };
  }
  if (payment.asset_code !== "USDC" || payment.asset_issuer !== expectedIssuer) {
    return {
      ok: false,
      reason: "asset_mismatch",
      detail: `got ${payment.asset_code}/${payment.asset_issuer}, expected USDC/${expectedIssuer}`,
    };
  }

  if (!isUsdcAmount(payment.amount) || !meetsUsdcAmount(payment.amount, opts.expected.amountUsdc)) {
    return {
      ok: false,
      reason: "underpayment",
      detail: `expected ${opts.expected.amountUsdc}, got ${payment.amount}`,
    };
  }

  return {
    ok: true,
    payer: payment.from,
    amount: payment.amount,
    txHash: opts.txHash,
    memo: tx.memo,
  };
}
