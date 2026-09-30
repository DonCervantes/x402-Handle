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

const CONTRACT_ID = process.env.REGISTRY_CONTRACT_ID;
if (!CONTRACT_ID) {
  console.error("Missing REGISTRY_CONTRACT_ID in .env");
  process.exit(1);
}

const POLL_LIMIT = 1000;

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

function providerRowId(providerId: bigint): string {
  return `${CONTRACT_ID}/${providerId}`;
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

async function upsertProvider(p: RawProvider, ledgerClosedAt: string): Promise<void> {
  await Bun.sql`
    INSERT INTO providers (
      id, contract_id, provider_id, name, endpoint, price_usdc,
      owner_account, payment_asset, category, active, created_at, last_seen_at, metadata
    ) VALUES (
      ${providerRowId(p.id)}, ${CONTRACT_ID}, ${Number(p.id)}, ${p.name}, ${p.endpoint},
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

async function upsertPayment(log: RawPaymentLog, ledger: number): Promise<void> {
  const txHashHex = Buffer.from(log.tx_hash).toString("hex");
  await Bun.sql`
    INSERT INTO payments (
      tx_hash, provider_id, payer_account, amount_usdc, ledger, paid_at
    ) VALUES (
      ${txHashHex}, ${providerRowId(log.provider_id)}, ${log.payer},
      ${stroopsToUsdc(log.amount)}, ${ledger}, ${tsToIso(log.timestamp)}
    )
    ON CONFLICT (tx_hash) DO NOTHING
  `;
}

async function deactivateProvider(providerId: bigint, ledgerClosedAt: string): Promise<void> {
  await Bun.sql`
    UPDATE providers
    SET active = false, last_seen_at = ${ledgerClosedAt}
    WHERE id = ${providerRowId(providerId)}
  `;
}

async function activateProvider(providerId: bigint, ledgerClosedAt: string): Promise<void> {
  await Bun.sql`
    UPDATE providers
    SET active = true, last_seen_at = ${ledgerClosedAt}
    WHERE id = ${providerRowId(providerId)}
  `;
}

async function runOnce(): Promise<{ ledger: number; providers: number; payments: number }> {
  const fromLedger = await getLastLedger();
  const events = await stellar.getContractEvents({
    contractId: CONTRACT_ID!,
    fromLedger,
    limit: POLL_LIMIT,
  });

  let providerCount = 0;
  let paymentCount = 0;
  let maxLedger = fromLedger;

  for (const ev of events) {
    const kind = ev.topics?.[1];
    if (kind === "prov_reg" || kind === "prov_upd") {
      await upsertProvider(ev.value as RawProvider, ev.timestamp);
      providerCount++;
    } else if (kind === "prov_off") {
      await deactivateProvider(ev.value as bigint, ev.timestamp);
      providerCount++;
    } else if (kind === "prov_on") {
      await activateProvider(ev.value as bigint, ev.timestamp);
      providerCount++;
    } else if (kind === "pay_log") {
      await upsertPayment(ev.value as RawPaymentLog, ev.ledger);
      paymentCount++;
    }
    if (ev.ledger > maxLedger) maxLedger = ev.ledger;
  }

  // Avanzar al menos al ledger actual + 1 para no re-pedir lo ya visto,
  // incluso si no hubo eventos nuevos.
  const latest = await stellar.getLatestLedger();
  const nextFrom = Math.max(maxLedger + 1, fromLedger, Math.min(latest, fromLedger));
  await setLastLedger(events.length > 0 ? maxLedger + 1 : Math.max(fromLedger, latest - 1));

  return { ledger: nextFrom, providers: providerCount, payments: paymentCount };
}

async function main(): Promise<void> {
  const watch = process.argv.includes("--watch");
  do {
    const result = await runOnce();
    console.log(
      `[indexer] ledger=${result.ledger} providers_seen=${result.providers} payments_seen=${result.payments}`
    );
    if (watch) await new Promise((r) => setTimeout(r, 5000));
  } while (watch);
}

main().catch((err) => {
  console.error("[indexer] fatal:", err);
  process.exit(1);
});
