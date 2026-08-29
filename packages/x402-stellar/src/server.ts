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
  isChallengeExpired,
  type X402Challenge,
  type X402ServerConfig,
} from "./types";
import { verifyUsdcPayment, type HorizonLike } from "./verify";
import { defaultReplayCache, type ReplayCache } from "./replay-cache";

/**
 * Almacén en memoria de challenges emitidos, indexado por memo.
 * Permite validar la expiración del challenge que vincula el memo
 * (evita que un memo antiguo se reutilice para un pago nuevo).
 */
export interface ChallengeStore {
  get(memo: string): X402Challenge | undefined;
  set(challenge: X402Challenge): void;
}

function createChallengeStore(): ChallengeStore {
  const store = new Map<string, X402Challenge>();
  return {
    get(memo: string) {
      return store.get(memo);
    },
    set(challenge: X402Challenge) {
      store.set(challenge.memo, challenge);
    },
  };
}

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
  replayCache?: ReplayCache;
  challengeStore?: ChallengeStore;
  horizonServer?: HorizonLike;
}

export function x402Stellar(opts: X402StellarMiddlewareOpts): MiddlewareHandler {
  const cache = opts.replayCache ?? defaultReplayCache;
  const challengeStore = opts.challengeStore ?? createChallengeStore();
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
      challengeStore.set(challenge);
      // Header informativo (opcional, no requerido por protocolo)
      c.header("X-PAYMENT-MEMO", memo);
      return c.json(challenge, 402);
    }

    // ─── Con pago: verificar ───────────────────────────────────────
    // El cliente debe enviar: X-PAYMENT: <tx_hash>;memo=<memo>
    // (admitimos también sólo <tx_hash> y validamos memo from Horizon)
    let txHash = paymentHeader.trim();
    let expectedMemo: string | undefined;
    if (paymentHeader.includes(";")) {
      const parts = paymentHeader.split(";").map((s) => s.trim());
      txHash = parts[0];
      for (const p of parts.slice(1)) {
        const [k, v] = p.split("=");
        if (k === "memo") expectedMemo = v;
      }
    }

    if (cache.has(txHash)) {
      return c.json(
        { error: "already_consumed", detail: "This payment was already used." },
        402
      );
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
      challengeStore.set(challenge);
      return c.json({ ...challenge, error: "missing_memo" }, 402);
    }

    // Si el memo corresponde a un challenge que emitimos, validamos su expiración.
    // Esto impide reutilizar un memo de un challenge ya vencido.
    const boundChallenge = challengeStore.get(expectedMemo);
    if (boundChallenge && isChallengeExpired(boundChallenge)) {
      return c.json(
        {
          error: "challenge_expired",
          detail: `Challenge for memo "${expectedMemo}" expired at ${boundChallenge.expires_at}`,
        },
        402
      );
    }

    const result = await verifyUsdcPayment({
      txHash,
      expected: {
        destination: opts.destination,
        amountUsdc: opts.amountUsdc,
        memo: expectedMemo,
        network: opts.network,
        usdcIssuer: issuer,
      },
      horizonUrl: opts.horizonUrl,
      horizonServer: opts.horizonServer,
    });

    if (!result.ok) {
      return c.json({ error: result.reason, detail: result.detail }, 402);
    }

    // ─── Pago válido: marcar consumido + callback opcional ───────────
    cache.add(txHash);
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
