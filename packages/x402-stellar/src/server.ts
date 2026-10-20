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

import { X402_VERSION, type X402Challenge, type X402ServerConfig } from "./types";
import { verifyUsdcPayment } from "./verify";
import { defaultReplayCache, type ReplayCache } from "./replay-cache";
import { defaultChallengeStore, type ChallengeStore } from "./challenge-store";

const USDC_ISSUERS = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  public: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
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
}

export function x402Stellar(opts: X402StellarMiddlewareOpts): MiddlewareHandler {
  const cache = opts.replayCache ?? defaultReplayCache;
  const challengeStore = opts.challengeStore ?? defaultChallengeStore;
  const ttl = opts.challengeTtlSec ?? 300;
  const issuer = opts.usdcIssuer ?? USDC_ISSUERS[opts.network];

  function issueChallenge(): X402Challenge {
    const memo = newMemo();
    const expiresAtMs = Date.now() + ttl * 1000;
    const challenge: X402Challenge = {
      version: X402_VERSION,
      network: opts.network,
      asset: { code: "USDC", issuer },
      amount: opts.amountUsdc,
      destination: opts.destination,
      memo,
      expires_at: new Date(expiresAtMs).toISOString(),
    };
    challengeStore.add({
      memo,
      destination: opts.destination,
      amount: opts.amountUsdc,
      network: opts.network,
      asset: { code: "USDC", issuer },
      expiresAt: expiresAtMs,
    });
    return challenge;
  }

  return async (c: Context, next) => {
    // Si hay pathPattern y no matchea, dejar pasar libre
    if (opts.pathPattern && !opts.pathPattern.test(c.req.path)) {
      return next();
    }

    const paymentHeader = c.req.header("X-PAYMENT");

    // ─── Sin pago: responder 402 con challenge ───────────────────────
    if (!paymentHeader) {
      const challenge = issueChallenge();
      // Header informativo (opcional, no requerido por protocolo)
      c.header("X-PAYMENT-MEMO", challenge.memo);
      return c.json(challenge, 402);
    }

    // ─── Con pago: verificar ───────────────────────────────────────
    // El cliente debe enviar: X-PAYMENT: <tx_hash>;memo=<memo>
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
      return c.json({ error: "already_consumed", detail: "This payment was already used." }, 402);
    }

    // Si el cliente no envió memo, no podemos verificar sin él.
    if (!expectedMemo) {
      const challenge = issueChallenge();
      c.header("X-PAYMENT-MEMO", challenge.memo);
      return c.json({ ...challenge, error: "missing_memo" }, 402);
    }

    // Validar que el memo haya sido emitido por este servidor y siga almacenado
    const storedChallenge = challengeStore.get(expectedMemo);
    if (!storedChallenge) {
      return c.json(
        {
          error: "unknown_memo",
          detail: "The provided memo was not issued by this server or has expired.",
        },
        402,
      );
    }

    const result = await verifyUsdcPayment({
      txHash,
      expected: {
        destination: storedChallenge.destination,
        amountUsdc: storedChallenge.amount,
        memo: storedChallenge.memo,
        network: storedChallenge.network,
        usdcIssuer: storedChallenge.asset.issuer,
      },
      horizonUrl: opts.horizonUrl,
    });

    if (!result.ok) {
      return c.json({ error: result.reason, detail: result.detail }, 402);
    }

    // ─── Pago válido: marcar consumido + callback opcional ───────────
    cache.add(txHash);
    challengeStore.consume(storedChallenge.memo);

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
