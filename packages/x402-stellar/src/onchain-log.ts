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
import { loadStellarConfig } from "contracts";

export interface OnChainLogOpts {
  contractId?: string;
  providerId: bigint;
  callerSecret: string;
  sorobanUrl?: string;
  network?: "testnet" | "public";
  confirmationTimeoutMs?: number;
}

export async function logPaymentOnChain(
  opts: OnChainLogOpts,
  payment: { txHash: string; payer: string; amount: string }
): Promise<void> {
  const config = loadStellarConfig();
  if (opts.contractId && opts.contractId !== config.registryContractId) {
    throw new Error("on-chain log contractId does not match REGISTRY_CONTRACT_ID");
  }
  if (opts.network && opts.network !== config.network) {
    throw new Error("on-chain log network does not match STELLAR_NETWORK");
  }
  if (opts.sorobanUrl && opts.sorobanUrl !== config.sorobanRpcUrl) {
    throw new Error("on-chain log sorobanUrl does not match SOROBAN_RPC_URL");
  }

  const server = new rpc.Server(config.sorobanRpcUrl);
  const networkPassphrase = config.network === "public" ? Networks.PUBLIC : Networks.TESTNET;
  const caller = Keypair.fromSecret(opts.callerSecret);
  const contract = new Contract(config.registryContractId);

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
        nativeToScVal(txHashBytes, { type: "bytes" })
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

  const deadline = Date.now() + (opts.confirmationTimeoutMs ?? 30_000);
  let getRes = await server.getTransaction(sendRes.hash);
  while (getRes.status === "NOT_FOUND") {
    if (Date.now() >= deadline) {
      throw new Error(`log_payment confirmation timed out after ${opts.confirmationTimeoutMs ?? 30_000}ms`);
    }
    await new Promise((r) => setTimeout(r, Math.min(1000, deadline - Date.now())));
    getRes = await server.getTransaction(sendRes.hash);
  }
  if (getRes.status !== "SUCCESS") {
    throw new Error(`log_payment tx failed: ${JSON.stringify(getRes)}`);
  }
}
