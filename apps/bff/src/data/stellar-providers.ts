// Ticket 4.4 — datos de providers Stellar (registry on-chain espejado en
// Postgres por apps/cli/indexer.ts) + KYB mock + Trust Score.
// Deliberadamente separado del data layer legacy (EVM/Solana) en ./postgres-live
// y ./analytics-source — son dominios distintos, no se mezclan.
import type { ProviderIntelligence, StatsOverview, StellarProvider } from "contracts";
import {
  computeTrustScore,
  rankProviders,
  type RankedProvider,
  type RankOptions,
} from "intelligence";
import { kyb } from "sources";
const { getKybStatus } = kyb;

type ProviderRow = {
  id: string;
  contract_id: string;
  provider_id: number | string;
  name: string;
  endpoint: string;
  price_usdc: string;
  owner_account: string;
  payment_asset: string;
  category: string | null;
  active: boolean;
  created_at: Date | string;
  last_seen_at: Date | string | null;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapProviderRow(row: ProviderRow): StellarProvider {
  return {
    id: row.id,
    contractId: row.contract_id,
    providerId: Number(row.provider_id),
    name: row.name,
    endpoint: row.endpoint,
    priceUsdc: Number(row.price_usdc),
    ownerAccount: row.owner_account,
    paymentAsset: row.payment_asset,
    category: row.category,
    active: row.active,
    createdAt: toIso(row.created_at),
    lastSeenAt: row.last_seen_at ? toIso(row.last_seen_at) : null,
  };
}

export async function listStellarProviders(): Promise<StellarProvider[]> {
  const rows = await Bun.sql<ProviderRow[]>`
    SELECT id, contract_id, provider_id, name, endpoint, price_usdc,
           owner_account, payment_asset, category, active, created_at, last_seen_at
    FROM providers
    ORDER BY provider_id ASC
  `;
  return rows.map(mapProviderRow);
}

export async function getStellarProviderById(id: string): Promise<StellarProvider | null> {
  const rows = await Bun.sql<ProviderRow[]>`
    SELECT id, contract_id, provider_id, name, endpoint, price_usdc,
           owner_account, payment_asset, category, active, created_at, last_seen_at
    FROM providers
    WHERE id = ${id}
  `;
  return rows[0] ? mapProviderRow(rows[0]) : null;
}

type FinancialStats = {
  volume30dUsdc: number;
  paymentCount30d: number;
  uniquePayers30d: number;
  lastPaymentAt: string | null;
  paymentCountLifetime: number;
};

async function getFinancialStats(providerId: string): Promise<FinancialStats> {
  const [agg30d] = await Bun.sql<
    Array<{
      volume: string | null;
      count: string | number;
      unique_payers: string | number;
    }>
  >`
    SELECT
      COALESCE(SUM(amount_usdc), 0) AS volume,
      COUNT(*) AS count,
      COUNT(DISTINCT payer_account) AS unique_payers
    FROM payments
    WHERE provider_id = ${providerId} AND paid_at >= now() - interval '30 days'
  `;
  const [lifetime] = await Bun.sql<Array<{ count: string | number }>>`
    SELECT COUNT(*) AS count FROM payments WHERE provider_id = ${providerId}
  `;
  const [latest] = await Bun.sql<Array<{ paid_at: Date | string }>>`
    SELECT paid_at FROM payments WHERE provider_id = ${providerId} ORDER BY paid_at DESC LIMIT 1
  `;

  return {
    volume30dUsdc: Number(agg30d?.volume ?? 0),
    paymentCount30d: Number(agg30d?.count ?? 0),
    uniquePayers30d: Number(agg30d?.unique_payers ?? 0),
    lastPaymentAt: latest ? toIso(latest.paid_at) : null,
    paymentCountLifetime: Number(lifetime?.count ?? 0),
  };
}

/**
 * Disputes/incidentes del provider, espejados por apps/cli/indexer.ts desde
 * los eventos del contrato de escrow (contracts/soroban-escrow): una disputa
 * por cada escrow con disputed_at no nulo del provider (lifetime).
 *
 * Este es el input real del claimsFactor del Trust Score — antes de escrow
 * no existía mecanismo de disputa y la función devolvía 0 (issue #14).
 *
 * El escrow está anclado a la payout address del provider (el `destination`
 * del challenge x402), que el indexer une con providers.owner_account.
 * Si la tabla aún no existe (deploy sin migración 020) o el indexer de escrow
 * no está activo, se devuelve 0 como en v1: sin señal, no penalizar.
 */
async function getDisputeCount(providerRowId: string): Promise<number> {
  try {
    const [row] = await Bun.sql<Array<{ count: string | number }>>`
      SELECT COUNT(*) AS count
      FROM escrows e
      JOIN providers p ON p.owner_account = e.provider_account
      WHERE p.id = ${providerRowId}
        AND e.disputed_at IS NOT NULL
    `;
    return Number(row?.count ?? 0);
  } catch (err) {
    console.warn("[stellar-providers] escrow disputes unavailable, defaulting to 0:", err);
    return 0;
  }
}

export async function getProviderIntelligence(id: string): Promise<ProviderIntelligence | null> {
  const provider = await getStellarProviderById(id);
  if (!provider) return null;

  const [kyb, financial, disputeCount] = await Promise.all([
    getKybStatus(id),
    getFinancialStats(id),
    getDisputeCount(id),
  ]);

  const trustScore = computeTrustScore({
    registeredAt: new Date(provider.createdAt),
    volume30dUsdc: financial.volume30dUsdc,
    kybStatus: kyb.status,
    disputeCount,
    paymentCount: financial.paymentCountLifetime,
    lastPaymentAt: financial.lastPaymentAt ? new Date(financial.lastPaymentAt) : null,
  });

  return {
    provider,
    kyb: {
      status: kyb.status,
      kybProvider: kyb.kybProvider,
      kybTier: kyb.kybTier,
      verifiedAt: kyb.verifiedAt,
    },
    financial: {
      volume30dUsdc: financial.volume30dUsdc,
      paymentCount30d: financial.paymentCount30d,
      uniquePayers30d: financial.uniquePayers30d,
      lastPaymentAt: financial.lastPaymentAt,
    },
    trustScore,
  };
}

/**
 * Ticket 5.6 (playground, paso "recommend") — ranking determinístico
 * (packages/intelligence/src/ranker.ts), sin IA. El insight con LLM (4.5/4.6)
 * queda diferido; esto es lo que el doc llama "el ranker sí queda".
 */
export async function recommendStellarProviders(opts: RankOptions): Promise<RankedProvider[]> {
  const providers = await listStellarProviders();
  const candidates = await Promise.all(
    providers.map(async (provider) => {
      const intelligence = await getProviderIntelligence(provider.id);
      return intelligence ? { provider, trustScore: intelligence.trustScore } : null;
    }),
  );
  return rankProviders(
    candidates.filter((c): c is NonNullable<typeof c> => c !== null),
    opts,
  );
}

/**
 * Ticket 5.7 — GET /stats/overview. Agregado en vivo (no hay cron
 * `apps/cli/stats.ts` en este POC): a la escala del hackathon, una query
 * directa sobre `providers`/`payments` es suficientemente rápida.
 */
export async function getStatsOverview(): Promise<StatsOverview> {
  const providers = await listStellarProviders();

  const verifiedFlags = await Promise.all(
    providers.map(async (p) => (await getKybStatus(p.id)).status === "verified"),
  );
  const verifiedProviderCount = verifiedFlags.filter(Boolean).length;

  const [lifetime] = await Bun.sql<
    Array<{ volume: string | null; count: string | number }>
  >`SELECT COALESCE(SUM(amount_usdc), 0) AS volume, COUNT(*) AS count FROM payments`;
  const [last30d] = await Bun.sql<
    Array<{ volume: string | null; count: string | number; unique_payers: string | number }>
  >`
    SELECT COALESCE(SUM(amount_usdc), 0) AS volume, COUNT(*) AS count,
           COUNT(DISTINCT payer_account) AS unique_payers
    FROM payments
    WHERE paid_at >= now() - interval '30 days'
  `;

  const categoryBreakdown = Object.entries(
    providers.reduce<Record<string, number>>((acc, p) => {
      const key = p.category ?? "sin categoría";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([category, providerCount]) => ({ category, providerCount }))
    .sort((a, b) => b.providerCount - a.providerCount);

  return {
    providerCount: providers.length,
    activeProviderCount: providers.filter((p) => p.active).length,
    verifiedProviderCount,
    paymentCountLifetime: Number(lifetime?.count ?? 0),
    volumeLifetimeUsdc: Number(lifetime?.volume ?? 0),
    volume30dUsdc: Number(last30d?.volume ?? 0),
    paymentCount30d: Number(last30d?.count ?? 0),
    uniqueAgentCount30d: Number(last30d?.unique_payers ?? 0),
    categoryBreakdown,
    generatedAt: new Date().toISOString(),
  };
}
