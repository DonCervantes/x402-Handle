// Ticket 3.6 — loguea un pago verificado en el registry on-chain (Soroban).
// Llamado opcionalmente desde server.ts después de verificar un pago x402.
// El firmante debe ser el owner del provider o un oracle autorizado.

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
}

export async function logPaymentOnChain(
  opts: OnChainLogOpts,
  payment: { txHash: string; payer: string }
): Promise<void> {
  const sorobanUrl =
    opts.sorobanUrl ??
    (opts.network === "public" ? "https://soroban.stellar.org" : "https://soroban-testnet.stellar.org");
  const networkPassphrase = opts.network === "public" ? Networks.PUBLIC : Networks.TESTNET;

  const server = new rpc.Server(sorobanUrl);
  const caller = Keypair.fromSecret(opts.callerSecret);
  const contract = new Contract(opts.contractId);

  const account = await server.getAccount(caller.publicKey());
  const txHashBytes = Buffer.from(payment.txHash, "hex");

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      contract.call(
        "log_payment",
        nativeToScVal(opts.providerId, { type: "u64" }),
        nativeToScVal(Address.fromString(payment.payer), { type: "address" }),
        nativeToScVal(txHashBytes, { type: "bytes" }),
        nativeToScVal(Address.fromString(caller.publicKey()), { type: "address" })
      )
    )
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(caller);

  const sendRes = await server.sendTransaction(prepared);
  if (sendRes.status === "ERROR") {
    throw new Error(`log_payment sendTransaction failed: ${JSON.stringify(sendRes.errorResult)}`);
  }

  let getRes = await server.getTransaction(sendRes.hash);
  while (getRes.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    getRes = await server.getTransaction(sendRes.hash);
  }
  if (getRes.status !== "SUCCESS") {
    throw new Error(`log_payment tx failed: ${JSON.stringify(getRes)}`);
  }
}
