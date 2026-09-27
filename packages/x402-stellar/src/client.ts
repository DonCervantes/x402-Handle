// code/x402-stellar-middleware/src/client.ts
//
// Helper para el lado agente: hace el GET, parsea el 402, construye y firma
// la tx Stellar (USDC payment con memo del challenge), espera confirmación
// en Horizon, y reintenta el request con X-PAYMENT: <tx_hash>;memo=<memo>.
//
// Uso:
//   const data = await x402Pay({ url, agentSecret, network: "testnet" });

import {
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  Keypair,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk";

import { X402ChallengeSchema, type X402Challenge } from "./types";

const HORIZON_URLS = {
  testnet: "https://horizon-testnet.stellar.org",
  public:  "https://horizon.stellar.org",
};

export interface X402PayOpts {
  /** URL del recurso protegido */
  url: string;
  /** Secret seed (S...) del agente que paga */
  agentSecret: string;
  network: "testnet" | "public";
  /** Opcional: method, headers, body para el request original */
  fetchInit?: RequestInit;
  /** Opcional: factory de fetch (default: globalThis.fetch) */
  fetchImpl?: typeof fetch;
  /** Opcional: máximo monto que el agente está dispuesto a pagar (USDC) */
  maxAmountUsdc?: number;
  /**
   * Opcional: cuenta de destino esperada (G...). Si se especifica, el pago se
   * aborta cuando el challenge del provider apunta a otra cuenta.
   *
   * Es el binding contra una fuente de verdad externa (p. ej. el `owner` del
   * provider en el registry Soroban): el agente sólo firma un pago a la cuenta
   * que ya conocía de antemano, así que un endpoint HTTP malicioso no puede
   * redirigir el USDC cambiando el `destination` del 402.
   */
  expectedDestination?: string;
  /** Opcional: timeout de espera de confirmación on-chain en ms (default 30s) */
  confirmationTimeoutMs?: number;
}

export interface X402PayResult {
  /** Respuesta final del recurso, ya servido */
  response: Response;
  /** Body parseado si es JSON */
  data?: unknown;
  /** Info de la tx que pagó */
  payment: {
    txHash: string;
    amount: string;
    memo: string;
    destination: string;
  };
  /** ms desde inicio hasta data recibida */
  elapsedMs: number;
}

export async function x402Pay(opts: X402PayOpts): Promise<X402PayResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const horizonUrl = HORIZON_URLS[opts.network];
  const networkPassphrase = opts.network === "public" ? Networks.PUBLIC : Networks.TESTNET;
  const server = new Horizon.Server(horizonUrl);

  const t0 = Date.now();

  // 1) Request inicial — esperamos 402
  const firstRes = await fetchImpl(opts.url, opts.fetchInit);
  if (firstRes.status !== 402) {
    // El endpoint no estaba protegido, o ya nos sirvió
    const data = await tryJson(firstRes);
    return {
      response: firstRes,
      data,
      payment: { txHash: "", amount: "0", memo: "", destination: "" },
      elapsedMs: Date.now() - t0,
    };
  }

  // 2) Parsear challenge
  const challengeRaw = await firstRes.json();
  const challenge: X402Challenge = X402ChallengeSchema.parse(challengeRaw);

  // 2b) Pin de red: el challenge debe ser de la red que el agente está pagando.
  //     Sin esto un endpoint respondía con un challenge de otra red y el agente
  //     lo firmaba igual (el passphrase se elige desde `opts.network`, no desde
  //     el challenge), gastando en una red distinta a la esperada.
  if (challenge.network !== opts.network) {
    throw new Error(
      `x402Pay: challenge network mismatch (expected ${opts.network}, got ${challenge.network})`,
    );
  }

  // 2c) Binding de destino: si el caller conoce de antemano la cuenta a la que
  //     debe pagar (registry `owner`), el challenge tiene que coincidir. Esta
  //     comprobación va acá —entre parsear el challenge y firmar— porque es el
  //     único punto donde el destino que se va a firmar está garantizado.
  if (opts.expectedDestination && challenge.destination !== opts.expectedDestination) {
    throw new Error(
      `x402Pay: challenge destination mismatch (expected ${opts.expectedDestination}, got ${challenge.destination})`,
    );
  }

  // 3) Guard rail: max amount
  if (opts.maxAmountUsdc != null && Number(challenge.amount) > opts.maxAmountUsdc) {
    throw new Error(
      `x402Pay: challenge amount ${challenge.amount} exceeds maxAmountUsdc ${opts.maxAmountUsdc}`
    );
  }

  // 4) Construir y firmar la transacción
  const keypair = Keypair.fromSecret(opts.agentSecret);
  const sourceAccount = await server.loadAccount(keypair.publicKey());

  const usdc = new Asset(challenge.asset.code, challenge.asset.issuer);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: challenge.destination,
        asset: usdc,
        amount: challenge.amount,
      })
    )
    .addMemo(Memo.text(challenge.memo))
    .setTimeout(60)
    .build();

  tx.sign(keypair);

  // 5) Submit y esperar finalidad
  const submitResult = await server.submitTransaction(tx);
  const txHash = submitResult.hash;

  // 6) Reintentar el request original con X-PAYMENT
  const headers = new Headers(opts.fetchInit?.headers ?? {});
  headers.set("X-PAYMENT", `${txHash};memo=${challenge.memo}`);

  const secondRes = await fetchImpl(opts.url, {
    ...opts.fetchInit,
    headers,
  });

  const data = await tryJson(secondRes);

  return {
    response: secondRes,
    data,
    payment: {
      txHash,
      amount: challenge.amount,
      memo: challenge.memo,
      destination: challenge.destination,
    },
    elapsedMs: Date.now() - t0,
  };
}

async function tryJson(res: Response): Promise<unknown | undefined> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try { return await res.json(); } catch { return undefined; }
  }
  return undefined;
}
