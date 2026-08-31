import { Horizon, Networks } from "@stellar/stellar-sdk";
import { loadStellarNetworkConfig } from "contracts";

const { network } = loadStellarNetworkConfig();
const config = {
  url:
    process.env.HORIZON_URL ||
    (network === "public" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org"),
  network: network === "public" ? Networks.PUBLIC : Networks.TESTNET,
};

export const horizon = new Horizon.Server(config.url, { allowHttp: false });
export const networkPassphrase = config.network;

// ───────────────────────────── Account

export async function getAccount(publicKey: string) {
  const acc = await horizon.loadAccount(publicKey);
  return {
    id: acc.account_id,
    sequence: acc.sequence,
    subentryCount: acc.subentry_count,
    balances: acc.balances.map((b: any) => ({
      assetType: b.asset_type,
      assetCode: b.asset_code,
      assetIssuer: b.asset_issuer,
      balance: b.balance,
    })),
    lastModifiedTime: acc.last_modified_time,
  };
}

// ───────────────────────────── Payments

export async function listPayments(
  publicKey: string,
  opts: { limit?: number; order?: "asc" | "desc"; cursor?: string } = {}
) {
  const builder = horizon
    .payments()
    .forAccount(publicKey)
    .limit(opts.limit ?? 50)
    .order(opts.order ?? "desc");
  if (opts.cursor) builder.cursor(opts.cursor);
  const page = await builder.call();
  return {
    records: page.records.map((p: any) => ({
      id: p.id,
      type: p.type,
      txHash: p.transaction_hash,
      from: p.from,
      to: p.to,
      amount: p.amount,
      assetType: p.asset_type,
      assetCode: p.asset_code,
      assetIssuer: p.asset_issuer,
      createdAt: p.created_at,
    })),
    cursor:
      page.records.length
        ? page.records[page.records.length - 1].paging_token
        : null,
  };
}

// ───────────────────────────── Transaction (for x402 verification)

export async function getTransaction(txHash: string) {
  const tx = await horizon.transactions().transaction(txHash).call();
  const opsPage = await horizon
    .operations()
    .forTransaction(txHash)
    .call();
  return {
    hash: tx.hash,
    successful: tx.successful,
    ledger: tx.ledger_attr,
    memo: tx.memo,
    memoType: tx.memo_type,
    createdAt: tx.created_at,
    operations: opsPage.records.map((o: any) => ({
      type: o.type,
      from: o.from,
      to: o.to,
      amount: o.amount,
      assetType: o.asset_type,
      assetCode: o.asset_code,
      assetIssuer: o.asset_issuer,
    })),
  };
}

// ───────────────────────────── Health

export async function ping(): Promise<boolean> {
  try {
    await horizon.ledgers().limit(1).order("desc").call();
    return true;
  } catch {
    return false;
  }
}
