// code/x402-stellar-middleware/src/verify.ts
//
// Verificación on-chain de un pago x402-Stellar.
// Consulta Horizon (única fuente de verdad) y valida cada campo
// contra el challenge esperado.

import type { VerifyResult, X402Challenge } from "./types";

const HORIZON_URLS = {
  testnet: "https://horizon-testnet.stellar.org",
  public:  "https://horizon.stellar.org",
};

export const USDC_ISSUERS = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  public:  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34KZVN",
} as const;

/**
 * Mínima superficie de Horizon que usa `verifyUsdcPayment`.
 * Permite inyectar un doble en los tests sin tocar la red.
 */
export interface HorizonLike {
  transactions(): { transaction(id: string): { call(): Promise<any> } };
  operations(): { forTransaction(id: string): { call(): Promise<any> } };
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
  horizonServer?: HorizonLike;   // doble inyectable (tests/offline)
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
interface ExpectedPayment {
  destination: string;
  amountUsdc: string;
  memo: string;
  usdcIssuer: string;
}

async function loadHorizonServer(horizonUrl: string): Promise<HorizonLike> {
  const { Horizon } = await import("@stellar/stellar-sdk");
  return new Horizon.Server(horizonUrl);
}

/**
 * Núcleo puro de la verificación: recibe la tx y la página de operaciones
 * ya obtenidas de Horizon (o de un doble en tests) y valida cada campo.
 * No depende de la red, así es trivial de testear.
 */
export function evaluatePayment(
  tx: any,
  opsPage: any,
  expected: ExpectedPayment,
  txHash: string
): VerifyResult {
  if (!tx.successful) {
    return { ok: false, reason: "tx_failed" };
  }

  // Memo: Horizon devuelve memo_type ("text", "id", "hash", "return", "none")
  // Para x402 usamos memo_type === "text".
  if (tx.memo_type !== "text" || tx.memo !== expected.memo) {
    return {
      ok: false,
      reason: "memo_mismatch",
      detail: `expected memo "${expected.memo}", got "${tx.memo}" (type=${tx.memo_type})`,
    };
  }

  const payment = opsPage.records.find(
    (o: any) => o.type === "payment" || o.type === "path_payment_strict_send" || o.type === "path_payment_strict_receive"
  );
  if (!payment) {
    return { ok: false, reason: "horizon_error", detail: "no payment operation in transaction" };
  }

  if (payment.to !== expected.destination) {
    return {
      ok: false,
      reason: "destination_mismatch",
      detail: `expected ${expected.destination}, got ${payment.to}`,
    };
  }

  if (payment.asset_type === "native") {
    return { ok: false, reason: "asset_mismatch", detail: "got XLM, expected USDC" };
  }
  if (payment.asset_code !== "USDC" || payment.asset_issuer !== expected.usdcIssuer) {
    return {
      ok: false,
      reason: "asset_mismatch",
      detail: `got ${payment.asset_code}/${payment.asset_issuer}, expected USDC/${expected.usdcIssuer}`,
    };
  }

  if (Number(payment.amount) < Number(expected.amountUsdc)) {
    return {
      ok: false,
      reason: "underpayment",
      detail: `expected ${expected.amountUsdc}, got ${payment.amount}`,
    };
  }

  return {
    ok: true,
    payer: payment.from,
    amount: payment.amount,
    txHash,
    memo: tx.memo,
  };
}

export async function verifyUsdcPayment(opts: VerifyOpts): Promise<VerifyResult> {
  const horizonUrl = opts.horizonUrl ?? HORIZON_URLS[opts.expected.network];
  const expectedIssuer = opts.expected.usdcIssuer ?? USDC_ISSUERS[opts.expected.network];
  // El cliente Horizon sólo se necesita en producción; se importa de forma
  // diferida para no acoplar la carga del módulo (y los tests) al SDK pesado.
  const server: HorizonLike =
    opts.horizonServer ?? (await loadHorizonServer(horizonUrl));

  let tx: any;
  try {
    tx = await server.transactions().transaction(opts.txHash).call();
  } catch (err: any) {
    if (err?.response?.status === 404) {
      return { ok: false, reason: "tx_not_found" };
    }
    return { ok: false, reason: "horizon_error", detail: String(err?.message ?? err) };
  }

  // Operations
  let opsPage: any;
  try {
    opsPage = await server.operations().forTransaction(opts.txHash).call();
  } catch (err: any) {
    return { ok: false, reason: "horizon_error", detail: String(err?.message ?? err) };
  }

  return evaluatePayment(
    tx,
    opsPage,
    {
      destination: opts.expected.destination,
      amountUsdc: opts.expected.amountUsdc,
      memo: opts.expected.memo,
      usdcIssuer: expectedIssuer,
    },
    opts.txHash
  );
}
