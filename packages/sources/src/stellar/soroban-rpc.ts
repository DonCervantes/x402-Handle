import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { loadStellarNetworkConfig } from "contracts";
import { networkPassphrase } from "./horizon";

const sorobanUrl = loadStellarNetworkConfig().sorobanRpcUrl;

export const sorobanRpc = new rpc.Server(sorobanUrl);

// ───────────────────────────── Simulate (read-only contract call)

export async function simulateContractCall(opts: {
  readerAccount: string;
  contractId: string;
  fn: string;
  args: xdr.ScVal[];
}) {
  const contract = new Contract(opts.contractId);
  const account = await sorobanRpc.getAccount(opts.readerAccount);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(opts.fn, ...opts.args))
    .setTimeout(30)
    .build();

  const sim = await sorobanRpc.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  if (!sim.result?.retval) {
    throw new Error("Simulation returned no value");
  }
  return scValToNative(sim.result.retval);
}

// ───────────────────────────── Events (for indexer)

export async function getContractEvents(opts: {
  contractId: string;
  fromLedger: number;
  limit?: number;
}) {
  const res = await sorobanRpc.getEvents({
    startLedger: opts.fromLedger,
    filters: [
      {
        type: "contract",
        contractIds: [opts.contractId],
      },
    ],
    limit: opts.limit ?? 100,
  });
  return res.events.map((e: any) => ({
    ledger: e.ledger,
    timestamp: e.ledgerClosedAt,
    contractId: e.contractId,
    topics: e.topic.map((t: any) => scValToNative(t)),
    value: scValToNative(e.value),
    type: e.type,
  }));
}

// ───────────────────────────── Health

export async function pingSoroban(): Promise<boolean> {
  try {
    await sorobanRpc.getHealth();
    return true;
  } catch {
    return false;
  }
}

export async function getLatestLedger(): Promise<number> {
  const r = await sorobanRpc.getLatestLedger();
  return r.sequence;
}
