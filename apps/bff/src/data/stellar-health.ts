// Ticket 4.8 — /stellar/health: checks de Horizon, Soroban RPC y DB.
import { stellar } from "sources";
import { getRegistryContractId } from "@flovia/x402-stellar";

export type StellarHealth = {
  status: "ok" | "degraded";
  horizon: boolean;
  soroban: boolean;
  database: boolean;
  registryContractId: string | null;
};

async function checkDatabase(): Promise<boolean> {
  try {
    await Bun.sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function getStellarHealth(): Promise<StellarHealth> {
  const [horizon, soroban, database] = await Promise.all([
    stellar.ping(),
    stellar.pingSoroban(),
    checkDatabase(),
  ]);

  return {
    status: horizon && soroban && database ? "ok" : "degraded",
    horizon,
    soroban,
    database,
    registryContractId: getRegistryContractId() ?? null,
  };
}
