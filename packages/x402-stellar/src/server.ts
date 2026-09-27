// code/x402-stellar-middleware/src/server.ts
//
// Middleware estilo Hono. Si el request no trae X-PAYMENT, responde 402
// con el challenge JSON. Si lo trae, verifica contra Horizon y, si es válido
// y no consumido, pasa al next handler.
//
// Uso:
//   import { x402Stellar } from "@flovia/x402-stellar";
//   app.use("/api/*", x402Stellar({ destination, amountUsdc, network }));

import type { Context, MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

import {
  X402_VERSION,
  type X402Challenge,
  type X402ServerConfig,
} from "./types";
import { verifyUsdcPayment } from "./verify";
import { normalizeTxHash, type ReplayStore } from "./replay-store";

const USDC_ISSUERS = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  public:  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

/**
 * Genera un memo único por challenge: corto (28 bytes Stellar) y aleatorio.
 * Formato: "fl-<10hex>" → 13 chars, dentro del límite Stellar.
 */
function newMemo(): string {
  return "fl-" + randomUUID().replace(/-/g, "").slice(0, 10);
}

export interface X402StellarMiddlewareOpts extends X402ServerConfig {
  /**
   * Durable store of consumed tx hashes. Required: an implicit in-process
   * default would let payments be replayed after a restart or on another
   * replica. Use createPostgresReplayStore / createRedisReplayStore in
   * production; createMemoryReplayStore only for tests and local dev.
   */
  replayStore: ReplayStore;
  /** Override for on-chain verification. Defaults to verifyUsdcPayment (Horizon). */
  verifyPayment?: typeof verifyUsdcPayment;
}

export function x402Stellar(opts: X402StellarMiddlewareOpts): MiddlewareHandler {
  const store = opts.replayStore;
  const verifyPayment = opts.verifyPayment ?? verifyUsdcPayment;
  const ttl = opts.challengeTtlSec ?? 300;
  const issuer = opts.usdcIssuer ?? USDC_ISSUERS[opts.network];

  return async (c: Context, next) => {
    // Si hay pathPattern y no matchea, dejar pasar libre
    if (opts.pathPattern && !opts.pathPattern.test(c.req.path)) {
      return next();
    }

    const paymentHeader = c.req.header("X-PAYMENT");

    // ─── Sin pago: responder 402 con challenge ───────────────────────
    if (!paymentHeader) {
      const memo = newMemo();
      const challenge: X402Challenge = {
        version: X402_VERSION,
        network: opts.network,
        asset: { code: "USDC", issuer },
        amount: opts.amountUsdc,
        destination: opts.destination,
        memo,
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      };
      // Header informativo (opcional, no requerido por protocolo)
      c.header("X-PAYMENT-MEMO", memo);
      return c.json(challenge, 402);
    }

    // ─── Con pago: verificar ───────────────────────────────────────
    // El cliente debe enviar: X-PAYMENT: <tx_hash>;memo=<memo>
    // (admitimos también sólo <tx_hash> y validamos memo from Horizon)
    let rawTxHash = paymentHeader.trim();
    let expectedMemo: string | undefined;
    if (paymentHeader.includes(";")) {
      const parts = paymentHeader.split(";").map((s) => s.trim());
      rawTxHash = parts[0];
      for (const p of parts.slice(1)) {
        const [k, v] = p.split("=");
        if (k === "memo") expectedMemo = v;
      }
    }

    const txHash = normalizeTxHash(rawTxHash);
    if (!txHash) {
      return c.json(
        { error: "invalid_tx_hash", detail: "X-PAYMENT must start with a 64-char hex tx hash." },
        402
      );
    }

    // Fast path: skip the Horizon round-trip for known replays. The atomic
    // claim below is what actually guarantees single use.
    let alreadyConsumed: boolean;
    try {
      alreadyConsumed = await store.has(txHash);
    } catch (err) {
      return replayStoreUnavailable(c, err);
    }
    if (alreadyConsumed) {
      return alreadyConsumedResponse(c);
    }

    // Si el cliente no envió memo, no podemos verificar sin él.
    // Lo recuperamos del request si fue enviado en query param "memo" como fallback,
    // o pedimos que se reenvíe el challenge (regenerar).
    if (!expectedMemo) {
      expectedMemo = c.req.query("memo");
    }
    if (!expectedMemo) {
      // No tenemos contra qué validar el memo → no podemos confirmar el pago
      const memo = newMemo();
      const challenge: X402Challenge = {
        version: X402_VERSION,
        network: opts.network,
        asset: { code: "USDC", issuer },
        amount: opts.amountUsdc,
        destination: opts.destination,
        memo,
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      };
      return c.json({ ...challenge, error: "missing_memo" }, 402);
    }

    const result = await verifyPayment({
      txHash,
      expected: {
        destination: opts.destination,
        amountUsdc: opts.amountUsdc,
        memo: expectedMemo,
        network: opts.network,
        usdcIssuer: issuer,
      },
      horizonUrl: opts.horizonUrl,
    });

    if (!result.ok) {
      return c.json({ error: result.reason, detail: result.detail }, 402);
    }

    // ─── Valid payment: atomically consume, settle, then serve ──────
    // Claim only after verification so a failed or not-yet-final payment is
    // not burned. Concurrent redemptions of one hash race here; one wins.
    let claimed: boolean;
    try {
      claimed = await store.claim(txHash);
    } catch (err) {
      return replayStoreUnavailable(c, err);
    }
    if (!claimed) {
      return alreadyConsumedResponse(c);
    }

    if (opts.settlePayment) {
      try {
        await opts.settlePayment({
          txHash: result.txHash,
          payer: result.payer,
          amount: result.amount,
          memo: result.memo,
        });
      } catch (err) {
        // The hash stays claimed: releasing it could re-open a replay if
        // settlement partially succeeded (e.g. TxConsumed was written).
        console.error("[x402-stellar] settlePayment failed:", err);
        return c.json(
          { error: "settlement_failed", detail: "Payment verified but settlement failed." },
          402
        );
      }
    }

    if (opts.onPaymentVerified) {
      try {
        await opts.onPaymentVerified({
          txHash: result.txHash,
          payer: result.payer,
          amount: result.amount,
          memo: result.memo,
        });
      } catch (err) {
        // Loggear pero no fallar el request — el pago ya fue real
        console.error("[x402-stellar] onPaymentVerified callback error:", err);
      }
    }

    // Adjuntar info del pago al contexto por si el handler quiere usarla
    c.set("x402Payment" as any, {
      txHash: result.txHash,
      payer: result.payer,
      amount: result.amount,
      memo: result.memo,
    });

    await next();
  };
}

function alreadyConsumedResponse(c: Context) {
  return c.json(
    { error: "already_consumed", detail: "This payment was already used." },
    402
  );
}

function replayStoreUnavailable(c: Context, err: unknown) {
  // Fail closed: without the replay store we cannot prove single use.
  console.error("[x402-stellar] replay store unavailable:", err);
  return c.json(
    { error: "replay_store_unavailable", detail: "Payment could not be checked; retry later." },
    503
  );
}
