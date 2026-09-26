// code/x402-stellar-middleware/src/verify.ts
//
// Verificación on-chain de un pago x402-Stellar.
// Consulta Horizon (única fuente de verdad) y valida cada campo
// contra el challenge esperado.

import { Horizon } from "@stellar/stellar-sdk";
import type { VerifyResult } from "./types";

const HORIZON_URLS = {
  testnet: "https://horizon-testnet.stellar.org",
  public: "https://horizon.stellar.org",
};

const USDC_ISSUERS = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  public: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

const PAYMENT_OP_TYPES = new Set([
  "payment",
  "path_payment_strict_send",
  "path_payment_strict_receive",
]);

function getAssetTuple(op: any) {
  return {
    type: op.asset_type ?? op.destination_asset_type ?? op.source_asset_type ?? "unknown",
    code: op.asset_code ?? op.destination_asset_code ?? op.source_asset_code ?? null,
    issuer: op.asset_issuer ?? op.destination_asset_issuer ?? op.source_asset_issuer ?? null,
  };
}

export function getPaymentOperationAmount(op: any): string | undefined {
  if (!PAYMENT_OP_TYPES.has(op?.type)) {
    return undefined;
  }

  if (op.type === "payment") {
    return op.amount;
  }

  return op.destination_amount ?? op.amount ?? op.source_amount;
}

export function paymentOpMatchesExpected(
  op: any,
  expectedIssuer: string,
  expectedDestination: string,
  expectedAmountUsdc: string,
): boolean {
  if (!PAYMENT_OP_TYPES.has(op?.type)) {
    return false;
  }

  const amount = getPaymentOperationAmount(op);
  if (amount == null) {
    return false;
  }

  const destination = op.to ?? op.destination_account;
  if (destination !== expectedDestination) {
    return false;
  }

  const { type, code, issuer } = getAssetTuple(op);
  if (type === "native") {
    return false;
  }
  if (code !== "USDC" || issuer !== expectedIssuer) {
    return false;
  }

  return Number(amount) >= Number(expectedAmountUsdc);
}

export function findMatchingPaymentOps(
  paymentOps: any[],
  expectedIssuer: string,
  expectedDestination: string,
  expectedAmountUsdc: string,
): any[] {
  return paymentOps.filter((op: any) =>
    paymentOpMatchesExpected(op, expectedIssuer, expectedDestination, expectedAmountUsdc)
  );
}

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

  const paymentOps = opsPage.records.filter((op: any) => PAYMENT_OP_TYPES.has(op?.type));
  if (paymentOps.length === 0) {
    return { ok: false, reason: "horizon_error", detail: "no payment operation in transaction" };
  }

  const matchingOps = findMatchingPaymentOps(
    paymentOps,
    expectedIssuer,
    opts.expected.destination,
    opts.expected.amountUsdc,
  );

  if (paymentOps.length === 1) {
    const payment = paymentOps[0];
    if (matchingOps.length === 1) {
      return {
        ok: true,
        payer: payment.from,
        amount: String(getPaymentOperationAmount(payment) ?? "0"),
        txHash: opts.txHash,
        memo: tx.memo,
      };
    }

    const firstDestination = payment.to ?? payment.destination_account;
    const firstAmount = getPaymentOperationAmount(payment);
    const firstAsset = getAssetTuple(payment);

    if (firstDestination !== opts.expected.destination) {
      return {
        ok: false,
        reason: "destination_mismatch",
        detail: `expected ${opts.expected.destination}, got ${firstDestination}`,
      };
    }
    if (firstAsset.type === "native") {
      return { ok: false, reason: "asset_mismatch", detail: "got XLM, expected USDC" };
    }
    if (firstAsset.code !== "USDC" || firstAsset.issuer !== expectedIssuer) {
      return {
        ok: false,
        reason: "asset_mismatch",
        detail: `got ${firstAsset.code}/${firstAsset.issuer}, expected USDC/${expectedIssuer}`,
      };
    }
    if (firstAmount == null) {
      return { ok: false, reason: "horizon_error", detail: "payment operation missing amount" };
    }
    if (Number(firstAmount) < Number(opts.expected.amountUsdc)) {
      return {
        ok: false,
        reason: "underpayment",
        detail: `expected ${opts.expected.amountUsdc}, got ${firstAmount}`,
      };
    }

    return {
      ok: false,
      reason: "horizon_error",
      detail: "payment operation does not match the expected x402 payment",
    };
  }

  if (matchingOps.length !== paymentOps.length) {
    return {
      ok: false,
      reason: "horizon_error",
      detail: "payment ops in transaction do not all match the expected x402 payment",
    };
  }

  const totalAmount = matchingOps.reduce((sum: number, op: any) => sum + Number(getPaymentOperationAmount(op) ?? 0), 0);
  if (totalAmount < Number(opts.expected.amountUsdc)) {
    return {
      ok: false,
      reason: "underpayment",
      detail: `expected ${opts.expected.amountUsdc}, got ${totalAmount}`,
    };
  }

  return {
    ok: true,
    payer: matchingOps[0].from,
    amount: String(totalAmount),
    txHash: opts.txHash,
    memo: tx.memo,
  };
}
