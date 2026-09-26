/**
 * Ticket 3.4 — Indexer: lee eventos del registry on-chain (Soroban) y los
 * espeja en Postgres (tablas providers/payments/indexer_state).
 *
 * Uso:
 *   bun --env-file=.env apps/cli/indexer.ts            # corre una pasada y termina
 *   bun --env-file=.env apps/cli/indexer.ts --watch    # corre en loop cada 5s
 *
 * Requiere en .env: REGISTRY_CONTRACT_ID, SOROBAN_RPC_URL, DATABASE_URL.
 */
import { stellar } from "sources";

const POLL_LIMIT = 1000;

function getContractId(): string {
  const contractId = process.env.REGISTRY_CONTRACT_ID;
  if (!contractId) {
    throw new Error("Missing REGISTRY_CONTRACT_ID in .env");
  }
  return contractId;
}

type RawProvider = {
  id: bigint;
  owner: string;
  name: string;
  endpoint: string;
  price_stroops: bigint;
  payment_token: string;
  category: string;
  created_at: bigint;
  updated_at: bigint;
  active: boolean;
};

type RawPaymentLog = {
  id: bigint;
  provider_id: bigint;
  payer: string;
  amount: bigint;
  tx_hash: Uint8Array;
  timestamp: bigint;
};

function providerRowId(providerId: bigint, contractId: string): string {
  return `${contractId}/${providerId}`;
}

function stroopsToUsdc(stroops: bigint): string {
  return (Number(stroops) / 10_000_000).toFixed(7);
}

function tsToIso(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

async function getLastLedger(): Promise<number> {
  const rows =
    await Bun.sql`SELECT value FROM indexer_state WHERE key = 'last_ledger'`;
  if (rows.length > 0) return Number(rows[0].value);
  // Primer arranque: arrancar ~30 min antes del último ledger para no
  // depender de conocer el ledger exacto del deploy.
  const latest = await stellar.getLatestLedger();
  return Math.max(latest - 6000, 1);
}

async function setLastLedger(ledger: number): Promise<void> {
  await Bun.sql`
    INSERT INTO indexer_state (key, value, updated_at)
    VALUES ('last_ledger', ${String(ledger)}, now())
    ON CONFLICT (key) DO UPDATE SET value = ${String(ledger)}, updated_at = now()
  `;
}

async function upsertProvider(
  contractId: string,
  p: RawProvider,
  ledgerClosedAt: string,
): Promise<void> {
  await Bun.sql`
    INSERT INTO providers (
      id, contract_id, provider_id, name, endpoint, price_usdc,
      owner_account, payment_asset, category, active, created_at, last_seen_at, metadata
    ) VALUES (
      ${providerRowId(p.id, contractId)}, ${contractId}, ${Number(p.id)}, ${p.name}, ${p.endpoint},
      ${stroopsToUsdc(p.price_stroops)}, ${p.owner}, 'USDC', ${p.category},
      ${p.active}, ${tsToIso(p.created_at)}, ${ledgerClosedAt}, '{}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      endpoint = EXCLUDED.endpoint,
      price_usdc = EXCLUDED.price_usdc,
      category = EXCLUDED.category,
      active = EXCLUDED.active,
      last_seen_at = EXCLUDED.last_seen_at
  `;
}

async function upsertPayment(
  contractId: string,
  log: RawPaymentLog,
  ledger: number,
): Promise<void> {
  const txHashHex = Buffer.from(log.tx_hash).toString("hex");
  await Bun.sql`
    INSERT INTO payments (
      tx_hash, provider_id, payer_account, amount_usdc, ledger, paid_at
    ) VALUES (
      ${txHashHex}, ${providerRowId(log.provider_id, contractId)}, ${log.payer},
      ${stroopsToUsdc(log.amount)}, ${ledger}, ${tsToIso(log.timestamp)}
    )
    ON CONFLICT (tx_hash) DO NOTHING
  `;
}

type SorobanEventLike = {
  ledger: number;
  topics?: unknown[];
  value?: unknown;
  timestamp?: string | number | bigint;
};

export async function fetchAndProcessSorobanEvents<TEvent extends SorobanEventLike>(opts: {
  fromLedger: number;
  latestLedger: number;
  limit: number;
  fetchPage: (ledger: number, limit: number) => Promise<TEvent[]>;
  onPage: (events: TEvent[]) => Promise<void>;
}): Promise<number> {
  let cursor = opts.fromLedger;
  let maxLedgerSeen = opts.fromLedger - 1;

  while (cursor <= opts.latestLedger) {
    const page = await opts.fetchPage(cursor, opts.limit);
    if (page.length === 0) {
      break;
    }

    await opts.onPage(page);

    for (const ev of page) {
      if (ev.ledger > maxLedgerSeen) {
        maxLedgerSeen = ev.ledger;
      }
    }

    cursor = maxLedgerSeen + 1;
  }

  return Math.max(opts.fromLedger, maxLedgerSeen + 1, opts.latestLedger + 1);
}

async function runOnce(): Promise<{ ledger: number; providers: number; payments: number }> {
  const contractId = getContractId();
  const fromLedger = await getLastLedger();
  const latest = await stellar.getLatestLedger();

  let providerCount = 0;
  let paymentCount = 0;

  const nextFrom = await fetchAndProcessSorobanEvents({
    fromLedger,
    latestLedger: latest,
    limit: POLL_LIMIT,
    fetchPage: async (cursor, limit) =>
      stellar.getContractEvents({
        contractId,
        fromLedger: cursor,
        limit,
      }),
    onPage: async (page) => {
      for (const ev of page) {
        const kind = ev.topics?.[1];
        if (kind === "prov_reg" || kind === "prov_upd") {
          await upsertProvider(contractId, ev.value as RawProvider, ev.timestamp as string);
          providerCount++;
        } else if (kind === "pay_log") {
          await upsertPayment(contractId, ev.value as RawPaymentLog, ev.ledger);
          paymentCount++;
        }
      }
    },
  });

  await setLastLedger(nextFrom);

  return { ledger: nextFrom, providers: providerCount, payments: paymentCount };
}

async function main(): Promise<void> {
  getContractId();
  const watch = process.argv.includes("--watch");
  do {
    const result = await runOnce();
    console.log(
      `[indexer] ledger=${result.ledger} providers_seen=${result.providers} payments_seen=${result.payments}`
    );
    if (watch) await new Promise((r) => setTimeout(r, 5000));
  } while (watch);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[indexer] fatal:", err);
    process.exit(1);
  });
}
