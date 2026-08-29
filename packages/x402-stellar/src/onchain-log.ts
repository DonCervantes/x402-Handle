// Ticket 3.6 — loguea un pago verificado en el registry on-chain (Soroban).
// Llamado opcionalmente desde server.ts después de verificar un pago x402.
// log_payment no requiere auth on-chain (ver contracts/soroban-registry):
// la protección es por tx_hash único, así que cualquier cuenta puede firmar.

import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Keypair,
  Address,
  nativeToScVal,
} from "@stellar/stellar-sdk";

export interface OnChainLogOpts {
  contractId: string;
  providerId: bigint;
  callerSecret: string;
  sorobanUrl?: string;
  network?: "testnet" | "public";
  /** Máx. polls de getTransaction esperando confirmación (default 15). */
  maxGetTransactionAttempts?: number;
  /** Espera entre polls de getTransaction en ms (default 1000). */
  pollIntervalMs?: number;
  /** Timeout global de espera de confirmación en ms (default 30s). */
  confirmationTimeoutMs?: number;
}

export async function logPaymentOnChain(
  opts: OnChainLogOpts,
  payment: { txHash: string; payer: string; amount: string },
): Promise<void> {
  const sorobanUrl =
    opts.sorobanUrl ??
    (opts.network === "public"
      ? "https://soroban.stellar.org"
      : "https://soroban-testnet.stellar.org");
  const networkPassphrase = opts.network === "public" ? Networks.PUBLIC : Networks.TESTNET;

  const server = new rpc.Server(sorobanUrl);
  const caller = Keypair.fromSecret(opts.callerSecret);
  const contract = new Contract(opts.contractId);

  const account = await server.getAccount(caller.publicKey());
  const amountStroops = BigInt(Math.round(Number(payment.amount) * 10_000_000));
  const txHashBytes = Buffer.from(payment.txHash, "hex");

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      contract.call(
        "log_payment",
        nativeToScVal(opts.providerId, { type: "u64" }),
        nativeToScVal(Address.fromString(payment.payer), { type: "address" }),
        nativeToScVal(amountStroops, { type: "u64" }),
        nativeToScVal(txHashBytes, { type: "bytes" }),
      ),
    )
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(caller);

  const sendRes = await server.sendTransaction(prepared);
  if (sendRes.status === "ERROR") {
    throw new Error(`log_payment sendTransaction failed: ${JSON.stringify(sendRes.errorResult)}`);
  }

  // Espera de confirmación acotada: nunca loopear NOT_FOUND para siempre
  // (un RPC de Soroban colgado no debe colgar al proceso del provider).
  const maxAttempts = opts.maxGetTransactionAttempts ?? 15;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const timeoutMs = opts.confirmationTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  let getRes = await server.getTransaction(sendRes.hash);
  let attempts = 1;
  while (getRes.status === "NOT_FOUND" && attempts < maxAttempts && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    getRes = await server.getTransaction(sendRes.hash);
    attempts += 1;
  }
  if (getRes.status === "NOT_FOUND") {
    throw new Error(
      `log_payment tx ${sendRes.hash} not confirmed on Soroban after ${attempts} attempts (${timeoutMs}ms timeout); giving up`,
    );
  }
  if (getRes.status !== "SUCCESS") {
    throw new Error(`log_payment tx failed: ${JSON.stringify(getRes)}`);
  }
}
