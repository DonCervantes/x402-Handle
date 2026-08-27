/**
 * Ticket 3.4 — Indexer: lee eventos del registry on-chain (Soroban) y los
 * espeja en Postgres (tablas providers/payments/indexer_state).
 *
 * Escrow (opt-in): si ESCROW_CONTRACT_ID está seteado, también indexa los
 * eventos del contrato de escrow (contracts/soroban-escrow) hacia la tabla
 * `escrows` (lock / release / refund / dispute / resolve). Las disputas
 * espejadas alimentan el claimsFactor del Trust Score en el BFF.
 *
 * Uso:
 *   bun --env-file=.env apps/cli/indexer.ts            # corre una pasada y termina
 *   bun --env-file=.env apps/cli/indexer.ts --watch    # corre en loop cada 5s
 *
 * Requiere en .env: REGISTRY_CONTRACT_ID, SOROBAN_RPC_URL, DATABASE_URL.
 * Opcional: ESCROW_CONTRACT_ID (y ESCROW_TOKEN_ID, para poblar escrows.token).
 */
import { stellar } from "sources";
import {
  classifyEscrowEvent,
  escrowEventToRow,
  type RawContractEvent,
} from "./scripts/escrow-events";

const CONTRACT_ID = process.env.REGISTRY_CONTRACT_ID;
if (!CONTRACT_ID) {
  console.error("Missing REGISTRY_CONTRACT_ID in .env");
  process.exit(1);
}

// Opt-in: sin ESCROW_CONTRACT_ID el indexer queda en modo registry-only (v1).
const ESCROW_CONTRACT_ID = process.env.ESCROW_CONTRACT_ID || null;
const ESCROW_TOKEN_ID = process.env.ESCROW_TOKEN_ID || undefined;

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

async function getLastLedger(key = "last_ledger"): Promise<number> {
  const rows = await Bun.sql`SELECT value FROM indexer_state WHERE key = ${key}`;
  if (rows.length > 0) return Number(rows[0].value);
  // Primer arranque: arrancar ~30 min antes del último ledger para no
  // depender de conocer el ledger exacto del deploy.
  const latest = await stellar.getLatestLedger();
  return Math.max(latest - 6000, 1);
}

async function setLastLedger(ledger: number, key = "last_ledger"): Promise<void> {
  await Bun.sql`
    INSERT INTO indexer_state (key, value, updated_at)
    VALUES (${key}, ${String(ledger)}, now())
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

/**
 * Espeja un evento de escrow en la tabla `escrows`. Cada payload lleva el
 * struct Escrow completo → el upsert es idempotente y tolerante a re-polls /
 * desorden. Los eventos admin (policy/oracle/paused) sólo se loggean.
 */
async function upsertEscrow(ev: RawContractEvent): Promise<boolean> {
  const kind = classifyEscrowEvent(ev);
  if (kind === null) return false;
  if (kind === "policy" || kind === "oracle" || kind === "paused") {
    console.log(`[indexer] escrow ${kind} event (ledger ${ev.ledger}) — not stored`);
    return false;
  }
  const row = escrowEventToRow(ev, { token: ESCROW_TOKEN_ID });
  if (!row) {
    console.warn(
      `[indexer] escrow ${kind} event with malformed payload (ledger ${ev.ledger}) — skipped`,
    );
    return false;
  }
  await Bun.sql`
    INSERT INTO escrows (
      contract_id, escrow_id, provider_account, agent_account, token,
      amount_stroops, amount_usdc, payment_ref, status,
      created_at, deadline_at, disputed_at, dispute_opener, resolved_at, resolver, updated_at
    ) VALUES (
      ${row.contractId}, ${row.escrowId}, ${row.providerAccount}, ${row.agentAccount}, ${row.token},
      ${row.amountStroops}, ${row.amountUsdc}, ${row.paymentRef}, ${row.status},
      ${row.createdAt}, ${row.deadlineAt}, ${row.disputedAt}, ${row.disputeOpener},
      ${row.resolvedAt}, ${row.resolver}, now()
    )
    ON CONFLICT (contract_id, escrow_id) DO UPDATE SET
      status = EXCLUDED.status,
      disputed_at = EXCLUDED.disputed_at,
      dispute_opener = EXCLUDED.dispute_opener,
      resolved_at = EXCLUDED.resolved_at,
      resolver = EXCLUDED.resolver,
      updated_at = now()
  `;
  return true;
}

async function runOnce(): Promise<{
  ledger: number;
  providers: number;
  payments: number;
  escrows: number;
}> {
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

  let escrowCount = 0;
  if (ESCROW_CONTRACT_ID) {
    escrowCount = await runEscrowOnce();
  }

  return {
    ledger: nextFrom,
    providers: providerCount,
    payments: paymentCount,
    escrows: escrowCount,
  };
}

/** Pasada del indexer de escrow (cursor propio: 'escrow_last_ledger'). */
async function runEscrowOnce(): Promise<number> {
  const fromLedger = await getLastLedger("escrow_last_ledger");
  const events = await stellar.getContractEvents({
    contractId: ESCROW_CONTRACT_ID!,
    fromLedger,
    limit: POLL_LIMIT,
  });

  let stored = 0;
  let maxLedger = fromLedger;
  for (const ev of events) {
    if (ev.contractId !== ESCROW_CONTRACT_ID) continue;
    if (await upsertEscrow(ev)) stored++;
    if (ev.ledger > maxLedger) maxLedger = ev.ledger;
  }

  const latest = await stellar.getLatestLedger();
  await setLastLedger(
    events.length > 0 ? maxLedger + 1 : Math.max(fromLedger, latest - 1),
    "escrow_last_ledger",
  );
  return stored;
}

async function main(): Promise<void> {
  const watch = process.argv.includes("--watch");
  if (ESCROW_CONTRACT_ID) {
    console.log(`[indexer] escrow indexing enabled: ${ESCROW_CONTRACT_ID}`);
  } else {
    console.log("[indexer] escrow indexing disabled (no ESCROW_CONTRACT_ID) — registry-only mode");
  }
  do {
    const result = await runOnce();
    console.log(
      `[indexer] ledger=${result.ledger} providers_seen=${result.providers} payments_seen=${result.payments} escrows_seen=${result.escrows}`,
    );
    if (watch) await new Promise((r) => setTimeout(r, 5000));
  } while (watch);
}

main().catch((err) => {
  console.error("[indexer] fatal:", err);
  process.exit(1);
});
