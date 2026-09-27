/**
 * Demo Provider — servidor Hono con UN endpoint /rate protegido por x402-Stellar.
 * Ticket 2.4 del Día 2.
 *
 * Uso:
 *   bun apps/demo-provider/src/index.ts
 *   # o desde raíz:
 *   bun --filter=demo-provider start
 */

import { SQL } from "bun";
import { Hono } from "hono";
import {
  createMemoryReplayStore,
  createPostgresReplayStore,
  logPaymentOnChain,
  type ReplayStore,
  x402Stellar,
} from "@flovia/x402-stellar";

const DESTINATION = process.env.DEMO_PROVIDER_PUBLIC;
const NETWORK = (process.env.STELLAR_NETWORK ?? "testnet") as "testnet" | "public";
const PORT = Number(process.env.DEMO_PROVIDER_PORT ?? 5402);
const REGISTRY_CONTRACT_ID = process.env.REGISTRY_CONTRACT_ID;
const PROVIDER_ID = 1n; // FX Rates Oracle, sembrado en ticket 3.3
const REPLAY_DATABASE_URL = process.env.X402_REPLAY_DATABASE_URL;

if (!DESTINATION) {
  console.error("Missing DEMO_PROVIDER_PUBLIC in env");
  process.exit(1);
}

// Consumed payment hashes must survive restarts and be shared by replicas.
async function createReplayStore(): Promise<ReplayStore> {
  if (REPLAY_DATABASE_URL) {
    const store = createPostgresReplayStore({ sql: new SQL(REPLAY_DATABASE_URL) });
    await store.ensureSchema();
    return store;
  }
  if (NETWORK === "public") {
    console.error("X402_REPLAY_DATABASE_URL is required on the public network");
    process.exit(1);
  }
  console.warn("[x402] X402_REPLAY_DATABASE_URL unset — using in-memory replay store (dev only)");
  return createMemoryReplayStore();
}

const app = new Hono();

// ─── Health (sin pago) ────────────────────────────────────────────
app.get("/health", (c) => c.json({ ok: true, provider: "flovia-demo-fx" }));

// ─── Rate endpoint (protegido por x402) ──────────────────────────
app.use(
  "/api/*",
  x402Stellar({
    destination: DESTINATION,
    amountUsdc: "0.005",
    network: NETWORK,
    replayStore: await createReplayStore(),
    onPaymentVerified: async ({ txHash, payer, amount, memo }) => {
      console.log(`[x402] payment verified — tx:${txHash.slice(0, 10)}... payer:${payer.slice(0, 8)}... amount:${amount} USDC memo:${memo}`);
      // Ticket 3.6 — espejar el pago en el registry on-chain (opcional, best-effort)
      if (REGISTRY_CONTRACT_ID && DESTINATION) {
        try {
          await logPaymentOnChain(
            {
              contractId: REGISTRY_CONTRACT_ID,
              providerId: PROVIDER_ID,
              callerSecret: process.env.DEMO_PROVIDER_SECRET!,
              network: NETWORK,
              sorobanUrl: process.env.SOROBAN_RPC_URL,
            },
            { txHash, payer, amount }
          );
          console.log(`[x402] payment logged on-chain — provider:${PROVIDER_ID} tx:${txHash.slice(0, 10)}...`);
        } catch (err) {
          console.error("[x402] log_payment on-chain failed:", err);
        }
      }
    },
  })
);

app.get("/api/rate", (c) => {
  const pair = c.req.query("pair") ?? "EUR/USD";
  // Datos simulados — en producción esto llama a una fuente real
  const rates: Record<string, number> = {
    "EUR/USD": 1.0843,
    "USD/MXN": 17.24,
    "BTC/USD": 61420.5,
  };
  return c.json({
    pair,
    rate: rates[pair] ?? 1.0,
    ts: new Date().toISOString(),
    provider: "flovia-demo-fx",
  });
});

console.log(`\n🚀 Demo provider listening on http://localhost:${PORT}`);
console.log(`   Destination: ${DESTINATION}`);
console.log(`   Network:     ${NETWORK}`);
console.log(`   Protected:   GET /api/rate?pair=EUR/USD (costs 0.005 USDC)\n`);

export default { port: PORT, fetch: app.fetch };
