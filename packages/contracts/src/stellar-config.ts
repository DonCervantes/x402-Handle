export type StellarNetwork = "testnet" | "public";

export type StellarConfig = {
  registryContractId: string;
  network: StellarNetwork;
  sorobanRpcUrl: string;
};

export type StellarNetworkConfig = {
  network: StellarNetwork;
  sorobanRpcUrl: string;
};

export class StellarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StellarConfigError";
  }
}

const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

export function loadStellarNetworkConfig(
  env: Record<string, string | undefined> = process.env,
): StellarNetworkConfig {
  const network = env.STELLAR_NETWORK?.trim() || "testnet";
  const sorobanRpcUrl = env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";

  if (network !== "testnet" && network !== "public") {
    throw new StellarConfigError("STELLAR_NETWORK must be either testnet or public.");
  }

  let rpcHost: string;
  try {
    rpcHost = new URL(sorobanRpcUrl).hostname.toLowerCase();
  } catch {
    throw new StellarConfigError("SOROBAN_RPC_URL must be a valid URL.");
  }
  const rpcNetwork = rpcHost.includes("testnet")
    ? "testnet"
    : rpcHost === "soroban.stellar.org"
      ? "public"
      : null;
  if (rpcNetwork && rpcNetwork !== network) {
    throw new StellarConfigError(
      `STELLAR_NETWORK=${network} does not match SOROBAN_RPC_URL=${sorobanRpcUrl}.`,
    );
  }

  return { network, sorobanRpcUrl };
}

export function loadStellarConfig(
  env: Record<string, string | undefined> = process.env,
): StellarConfig {
  const registryContractId = env.REGISTRY_CONTRACT_ID?.trim();
  if (!registryContractId || !CONTRACT_ID_PATTERN.test(registryContractId)) {
    throw new StellarConfigError(
      "REGISTRY_CONTRACT_ID must be a valid Stellar contract ID (C...).",
    );
  }
  return { registryContractId, ...loadStellarNetworkConfig(env) };
}