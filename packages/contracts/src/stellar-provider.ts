import { z } from "zod";

// Provider tal como lo expone el registry Soroban + el indexer (apps/cli/indexer.ts).
// Ver contracts/soroban-registry/src/lib.rs (struct Provider) y
// apps/data/migrations/019_stellar_registry_indexer.sql (tabla `providers`).

export const KybStatusSchema = z.enum(["verified", "demo_verified", "pending", "none"]);
export type KybStatus = z.infer<typeof KybStatusSchema>;

export const StellarProviderSchema = z
  .object({
    id: z.string().min(1), // "<contractId>/<providerId>"
    contractId: z.string().min(1),
    providerId: z.number().int().nonnegative(),
    name: z.string().min(1),
    endpoint: z.string().url(),
    priceUsdc: z.number().nonnegative(),
    ownerAccount: z.string().min(1),
    paymentAsset: z.string().min(1),
    category: z.string().min(1).nullable(),
    active: z.boolean(),
    createdAt: z.string().datetime(),
    lastSeenAt: z.string().datetime().nullable(),
  })
  .strict();

export type StellarProvider = z.infer<typeof StellarProviderSchema>;

export const TrustScoreComponentsSchema = z
  .object({
    age: z.number().min(0).max(1),
    volume: z.number().min(0).max(1),
    kyb: z.number().min(0).max(1),
    claims: z.number().min(0).max(1),
    recency: z.number().min(0).max(1),
  })
  .strict();

export type TrustScoreComponents = z.infer<typeof TrustScoreComponentsSchema>;

export const TrustScoreWeightsSchema = z
  .object({
    age: z.literal(0.15),
    volume: z.literal(0.3),
    kyb: z.literal(0.3),
    claims: z.literal(0.15),
    recency: z.literal(0.1),
  })
  .strict();

export const TrustScoreSchema = z
  .object({
    score: z.number().int().min(0).max(100),
    components: TrustScoreComponentsSchema,
    weights: TrustScoreWeightsSchema,
    computedAt: z.string().datetime(),
  })
  .strict();

export type TrustScore = z.infer<typeof TrustScoreSchema>;

export const ProviderIntelligenceSchema = z
  .object({
    provider: StellarProviderSchema,
    kyb: z
      .object({
        status: KybStatusSchema,
        kybProvider: z.string().optional(),
        kybTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        verifiedAt: z.string().datetime().optional(),
      })
      .strict(),
    financial: z
      .object({
        volume30dUsdc: z.number().nonnegative(),
        paymentCount30d: z.number().int().nonnegative(),
        uniquePayers30d: z.number().int().nonnegative(),
        lastPaymentAt: z.string().datetime().nullable(),
      })
      .strict(),
    trustScore: TrustScoreSchema,
  })
  .strict();

export type ProviderIntelligence = z.infer<typeof ProviderIntelligenceSchema>;

// Ticket 5.7 — GET /stats/overview. Métricas globales agregadas en vivo desde
// `providers`/`payments` (sin cron `apps/cli/stats.ts`: a esta escala de
// hackathon una query directa es suficientemente rápida y evita una capa de
// cache adicional a la que mantenerle coherencia).
export const StatsOverviewSchema = z
  .object({
    providerCount: z.number().int().nonnegative(),
    activeProviderCount: z.number().int().nonnegative(),
    verifiedProviderCount: z.number().int().nonnegative(),
    paymentCountLifetime: z.number().int().nonnegative(),
    volumeLifetimeUsdc: z.number().nonnegative(),
    volume30dUsdc: z.number().nonnegative(),
    paymentCount30d: z.number().int().nonnegative(),
    uniqueAgentCount30d: z.number().int().nonnegative(),
    categoryBreakdown: z.array(
      z.object({ category: z.string(), providerCount: z.number().int().nonnegative() }),
    ),
    generatedAt: z.string().datetime(),
  })
  .strict();

export type StatsOverview = z.infer<typeof StatsOverviewSchema>;
