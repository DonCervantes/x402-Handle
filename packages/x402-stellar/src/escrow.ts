// Escrow client for contracts/soroban-escrow (opt-in path for x402 calls over
// threshold). Mirrors the submit pattern of onchain-log.ts: build →
// prepareTransaction (embeds simulation auth entries) → sign → send → wait.
//
// Lifecycle cheat-sheet (full state machine in contracts/soroban-escrow):
//   provider:  setEscrowPolicy (opt-in: min amount + dispute window)
//   agent:     escrowApprove → escrowLock → (deliver) → escrowRelease
//              or wait for the deadline → escrowRefund (timeout policy:
//              refund to agent; permissionless)
//   dispute:   escrowDispute (agent|provider) → escrowResolve (admin|oracle)

import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Keypair,
  Address,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";

export interface EscrowContractOpts {
  contractId: string;
  /** Soroban RPC URL (defaults per network). */
  sorobanUrl?: string;
  network?: "testnet" | "public";
}

export const USDC_STROOPS_DECIMALS = 7;

/** "0.005" USDC → 50_000n stroops. */
export function usdcToStroops(amountUsdc: string | number): bigint {
  return BigInt(Math.round(Number(amountUsdc) * 10 ** USDC_STROOPS_DECIMALS));
}

function resolveServer(opts: EscrowContractOpts): { server: rpc.Server; passphrase: string } {
  const sorobanUrl =
    opts.sorobanUrl ??
    (opts.network === "public"
      ? "https://soroban.stellar.org"
      : "https://soroban-testnet.stellar.org");
  const passphrase = opts.network === "public" ? Networks.PUBLIC : Networks.TESTNET;
  return { server: new rpc.Server(sorobanUrl), passphrase };
}

/** sha256 of the x402 payment tx hash / challenge id, as 32 bytes. */
export function paymentRefFromTxHash(txHashHex: string): Buffer {
  return createHash("sha256").update(Buffer.from(txHashHex, "hex")).digest();
}

type SorobanAccount = Awaited<ReturnType<rpc.Server["getAccount"]>>;

async function submitAndWait(
  opts: EscrowContractOpts,
  caller: Keypair,
  build: (contract: Contract, account: SorobanAccount, passphrase: string) => Promise<any>,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const { server, passphrase } = resolveServer(opts);
  const contract = new Contract(opts.contractId);
  const account = await server.getAccount(caller.publicKey());

  const tx = await build(contract, account, passphrase);
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(caller);

  const sendRes = await server.sendTransaction(prepared);
  if (sendRes.status === "ERROR") {
    throw new Error(`escrow tx sendTransaction failed: ${JSON.stringify(sendRes.errorResult)}`);
  }

  let getRes = await server.getTransaction(sendRes.hash);
  while (getRes.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    getRes = await server.getTransaction(sendRes.hash);
  }
  if (getRes.status !== "SUCCESS") {
    throw new Error(`escrow tx failed: ${JSON.stringify(getRes)}`);
  }
  return getRes;
}

function u64Val(v: bigint | number) {
  return nativeToScVal(v, { type: "u64" });
}

function i128Val(v: bigint | number) {
  return nativeToScVal(v, { type: "i128" });
}

function addressVal(v: string) {
  return nativeToScVal(Address.fromString(v), { type: "address" });
}

/** Agent grants the escrow contract a SAC allowance (needed before lock). */
export async function escrowApprove(
  opts: EscrowContractOpts & { tokenId: string },
  payment: { agentSecret: string; amountStroops: bigint; ttlLedgers?: number },
): Promise<void> {
  const caller = Keypair.fromSecret(payment.agentSecret);
  await submitAndWait(opts, caller, async (contract, account, passphrase) =>
    new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(
        new Contract(opts.tokenId).call(
          "approve",
          addressVal(caller.publicKey()),
          addressVal(opts.contractId),
          i128Val(payment.amountStroops),
          u64Val(payment.ttlLedgers ?? 120_960), // ~7 days of 5s ledgers
        ),
      )
      .setTimeout(60)
      .build(),
  );
}

/** Provider opt-in: escrow enabled, minimum lock amount and dispute window. */
export async function setEscrowPolicy(
  opts: EscrowContractOpts,
  policy: {
    providerSecret: string;
    enabled: boolean;
    minLockStroops: bigint | number;
    disputeWindowSecs: number;
  },
): Promise<void> {
  const caller = Keypair.fromSecret(policy.providerSecret);
  await submitAndWait(opts, caller, async (contract, account, passphrase) =>
    new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(
        contract.call(
          "set_policy",
          addressVal(caller.publicKey()),
          nativeToScVal(policy.enabled),
          i128Val(policy.minLockStroops),
          u64Val(policy.disputeWindowSecs),
        ),
      )
      .setTimeout(60)
      .build(),
  );
}

/** Agent locks funds for an x402 call. Returns the on-chain escrow id. */
export async function escrowLock(
  opts: EscrowContractOpts,
  lock: {
    agentSecret: string;
    /** Provider payout address (the x402 challenge `destination`). */
    provider: string;
    amountStroops: bigint;
    /** 32-byte payment reference (see paymentRefFromTxHash). */
    paymentRef: Buffer;
  },
): Promise<bigint> {
  const caller = Keypair.fromSecret(lock.agentSecret);
  const res = await submitAndWait(opts, caller, async (contract, account, passphrase) =>
    new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(
        contract.call(
          "lock",
          addressVal(caller.publicKey()),
          addressVal(lock.provider),
          i128Val(lock.amountStroops),
          nativeToScVal(lock.paymentRef, { type: "bytes" }),
        ),
      )
      .setTimeout(60)
      .build(),
  );
  if (!res.returnValue) {
    throw new Error("escrowLock returned no value (expected escrow id)");
  }
  return scValToNative(res.returnValue) as bigint;
}

/** Agent acks delivery (or oracle releases on proof of delivery). */
export async function escrowRelease(
  opts: EscrowContractOpts,
  release: { callerSecret: string; escrowId: bigint | number },
): Promise<void> {
  const caller = Keypair.fromSecret(release.callerSecret);
  await submitAndWait(opts, caller, async (contract, account, passphrase) =>
    new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(
        contract.call("release", addressVal(caller.publicKey()), u64Val(release.escrowId)),
      )
      .setTimeout(60)
      .build(),
  );
}

/**
 * Timeout policy: refund to agent. Permissionless on-chain — any account can
 * submit it, so passers-by/keepers can trigger refunds for stuck agents.
 */
export async function escrowRefund(
  opts: EscrowContractOpts,
  refund: { feePayerSecret: string; escrowId: bigint | number },
): Promise<void> {
  const caller = Keypair.fromSecret(refund.feePayerSecret);
  await submitAndWait(opts, caller, async (contract, account, passphrase) =>
    new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(contract.call("refund", u64Val(refund.escrowId)))
      .setTimeout(60)
      .build(),
  );
}

/** Agent or provider opens a dispute (before the deadline). */
export async function escrowDispute(
  opts: EscrowContractOpts,
  dispute: { callerSecret: string; escrowId: bigint | number },
): Promise<void> {
  const caller = Keypair.fromSecret(dispute.callerSecret);
  await submitAndWait(opts, caller, async (contract, account, passphrase) =>
    new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(
        contract.call("dispute", addressVal(caller.publicKey()), u64Val(dispute.escrowId)),
      )
      .setTimeout(60)
      .build(),
  );
}

/** Admin or oracle resolves a dispute. */
export async function escrowResolve(
  opts: EscrowContractOpts,
  resolve: {
    adminSecret: string;
    escrowId: bigint | number;
    releaseToProvider: boolean;
  },
): Promise<void> {
  const caller = Keypair.fromSecret(resolve.adminSecret);
  await submitAndWait(opts, caller, async (contract, account, passphrase) =>
    new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(
        contract.call(
          "resolve",
          addressVal(caller.publicKey()),
          u64Val(resolve.escrowId),
          nativeToScVal(resolve.releaseToProvider),
        ),
      )
      .setTimeout(60)
      .build(),
  );
}
