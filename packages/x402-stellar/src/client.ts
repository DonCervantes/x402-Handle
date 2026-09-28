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
  public: "https://horizon.stellar.org",
};

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30_000;
const DEFAULT_CONFIRMATION_POLL_INTERVAL_MS = 1_000;

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
  /** Opcional: timeout de espera de confirmación on-chain en ms (default 30s) */
  confirmationTimeoutMs?: number;
  /** Opcional: intervalo entre polls a Horizon en ms (default 1s) */
  confirmationPollIntervalMs?: number;
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

/** Resultado de una sonda a Horizon para un hash concreto. */
export type HorizonProbeResult =
  | { status: "success" }
  | { status: "failed"; message?: string }
  | { status: "not_found" }
  | { status: "error"; message: string };

/** Consulta un hash en Horizon. Debe mapear 404 -> not_found y el resto de fallos -> error. */
export type HorizonProbe = (txHash: string) => Promise<HorizonProbeResult>;

export type X402ConfirmationErrorCode =
  | "confirmation_timeout"
  | "transaction_not_found"
  | "transaction_failed";

/** El polling agotó el timeout sin obtener una respuesta concluyente de Horizon. */
export class X402ConfirmationTimeoutError extends Error {
  readonly code = "confirmation_timeout" as const;
  readonly txHash: string;
  readonly timeoutMs: number;
  readonly attempts: number;

  constructor(txHash: string, timeoutMs: number, attempts: number, detail?: string) {
    super(
      `x402Pay: confirmation timed out after ${timeoutMs}ms waiting for tx ${txHash}` +
        ` (${attempts} attempts)${detail ? `: ${detail}` : ""}`,
    );
    this.name = "X402ConfirmationTimeoutError";
    this.txHash = txHash;
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
  }
}

/** Horizon respondió 404 en toda la ventana: la tx nunca llegó a existir. */
export class X402TransactionNotFoundError extends Error {
  readonly code = "transaction_not_found" as const;
  readonly txHash: string;
  readonly timeoutMs: number;
  readonly attempts: number;

  constructor(txHash: string, timeoutMs: number, attempts: number) {
    super(
      `x402Pay: tx ${txHash} not found in Horizon after ${attempts} attempts within ${timeoutMs}ms`,
    );
    this.name = "X402TransactionNotFoundError";
    this.txHash = txHash;
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
  }
}

/** La tx existe en Horizon pero no fue exitosa. */
export class X402TransactionFailedError extends Error {
  readonly code = "transaction_failed" as const;
  readonly txHash: string;

  constructor(txHash: string, detail?: string) {
    super(`x402Pay: tx ${txHash} failed in Horizon${detail ? `: ${detail}` : ""}`);
    this.name = "X402TransactionFailedError";
    this.txHash = txHash;
  }
}

export interface ConfirmationWaitOptions {
  txHash: string;
  /** ms máximos de espera (default 30000) */
  timeoutMs?: number;
  /** ms entre intentos (default 1000) */
  pollIntervalMs?: number;
  /** inyectable para tests */
  sleep?: (ms: number) => Promise<void>;
  /** inyectable para tests */
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isHorizonNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; status?: unknown; response?: { status?: unknown } };
  if (candidate.name === "NotFoundError") return true;
  return candidate.response?.status === 404 || candidate.status === 404;
}

/** Adaptador: consulta Horizon y normaliza la respuesta a HorizonProbeResult. */
export function createHorizonProbe(server: Horizon.Server): HorizonProbe {
  return async (txHash: string): Promise<HorizonProbeResult> => {
    try {
      const record = await server.transactions().transaction(txHash).call();
      return record.successful
        ? { status: "success" }
        : { status: "failed", message: "transaction included in a ledger but not successful" };
    } catch (error) {
      if (isHorizonNotFound(error)) return { status: "not_found" };
      return { status: "error", message: errorMessage(error) };
    }
  };
}

/**
 * Espera a que Horizon confirme la tx antes de reintentar con X-PAYMENT.
 * Distingue timeout (sin respuesta concluyente) de not-found (404 continuo).
 */
export async function waitForConfirmation(
  probe: HorizonProbe,
  options: ConfirmationWaitOptions,
): Promise<void> {
  const { txHash } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_CONFIRMATION_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const deadline = now() + timeoutMs;
  let attempts = 0;
  let last: HorizonProbeResult = { status: "error", message: "horizon was never queried" };
  let lastError: string | undefined;

  while (now() < deadline) {
    attempts += 1;
    try {
      last = await probe(txHash);
    } catch (error) {
      last = { status: "error", message: errorMessage(error) };
    }

    if (last.status === "success") return;
    if (last.status === "failed") {
      throw new X402TransactionFailedError(txHash, last.message);
    }
    if (last.status === "error") lastError = last.message;

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  if (last.status === "not_found") {
    throw new X402TransactionNotFoundError(txHash, timeoutMs, attempts);
  }

  throw new X402ConfirmationTimeoutError(txHash, timeoutMs, attempts, lastError);
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

  // 3) Guard rail: max amount
  if (opts.maxAmountUsdc != null && Number(challenge.amount) > opts.maxAmountUsdc) {
    throw new Error(
      `x402Pay: challenge amount ${challenge.amount} exceeds maxAmountUsdc ${opts.maxAmountUsdc}`,
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
      }),
    )
    .addMemo(Memo.text(challenge.memo))
    .setTimeout(60)
    .build();

  tx.sign(keypair);

  // 5) Submit y esperar finalidad en Horizon antes de reintentar con X-PAYMENT
  const submitResult = await server.submitTransaction(tx);
  const txHash = submitResult.hash;

  await waitForConfirmation(createHorizonProbe(server), {
    txHash,
    timeoutMs: opts.confirmationTimeoutMs,
    pollIntervalMs: opts.confirmationPollIntervalMs,
  });

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
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
  return undefined;
}
