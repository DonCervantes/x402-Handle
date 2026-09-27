// Stellar network profiles for HANDLE: one place that ties a network name
// to its passphrase, endpoints and the USDC issuer + SAC for that network,
// so Testnet and Public USDC can never be mixed.
//
// SAC contract IDs are deterministic (hash of network passphrase + asset);
// tests/networks.test.ts re-derives them with Asset#contractId.

import { Networks, StrKey } from "@stellar/stellar-sdk";

export type StellarNetwork = "testnet" | "public";

export interface StellarNetworkProfile {
  network: StellarNetwork;
  label: string;
  networkPassphrase: string;
  horizonUrl: string;
  /** SDF-hosted RPC. Public has none; operators must set STELLAR_RPC_URL. */
  defaultRpcUrl?: string;
  usdc: { code: "USDC"; issuer: string; sacContractId: string };
}

export const STELLAR_NETWORK_PROFILES: Readonly<Record<StellarNetwork, StellarNetworkProfile>> = {
  testnet: {
    network: "testnet",
    label: "Testnet",
    networkPassphrase: Networks.TESTNET,
    horizonUrl: "https://horizon-testnet.stellar.org",
    defaultRpcUrl: "https://soroban-testnet.stellar.org",
    usdc: {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      sacContractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    },
  },
  public: {
    network: "public",
    label: "Public",
    networkPassphrase: Networks.PUBLIC,
    horizonUrl: "https://horizon.stellar.org",
    usdc: {
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sacContractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    },
  },
};

export function isStellarNetwork(value: unknown): value is StellarNetwork {
  return value === "testnet" || value === "public";
}

/**
 * Throws unless `address` is the USDC SAC for `network`. Rejects the other
 * network's USDC SAC, account addresses and any other contract (e.g. a
 * placeholder from Address::generate or the provider's own key).
 */
export function assertUsdcPaymentToken(network: StellarNetwork, address: string): void {
  const expected = STELLAR_NETWORK_PROFILES[network].usdc.sacContractId;
  if (address === expected) return;

  const other = Object.values(STELLAR_NETWORK_PROFILES).find(
    (p) => p.usdc.sacContractId === address,
  );
  if (other) {
    throw new Error(
      `payment_token ${address} is the ${other.label} USDC SAC, but STELLAR_NETWORK=${network} (expected ${expected})`,
    );
  }
  throw new Error(
    `payment_token ${address} is not the ${STELLAR_NETWORK_PROFILES[network].label} USDC SAC (expected ${expected})`,
  );
}

export interface ResolvedStellarEnv {
  network: StellarNetwork;
  profile: StellarNetworkProfile;
  rpcUrl: string;
  registryContractId?: string;
}

/**
 * Resolves and cross-checks Stellar settings from env. Admin/owner secrets
 * are intentionally not read here; load them from a secret store at the
 * call site and never commit them.
 */
export function resolveStellarEnv(env: Record<string, string | undefined>): ResolvedStellarEnv {
  const network = env.STELLAR_NETWORK;
  if (!isStellarNetwork(network)) {
    throw new Error(
      `STELLAR_NETWORK must be "testnet" or "public", got ${JSON.stringify(network)}`,
    );
  }
  const profile = STELLAR_NETWORK_PROFILES[network];

  const rpcUrl = env.STELLAR_RPC_URL || env.SOROBAN_RPC_URL || profile.defaultRpcUrl;
  if (!rpcUrl) {
    throw new Error(
      `STELLAR_RPC_URL is required for STELLAR_NETWORK=${network} (no SDF-hosted RPC)`,
    );
  }

  if (
    env.STELLAR_NETWORK_PASSPHRASE &&
    env.STELLAR_NETWORK_PASSPHRASE !== profile.networkPassphrase
  ) {
    throw new Error(
      `STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK=${network} (expected "${profile.networkPassphrase}")`,
    );
  }

  if (env.USDC_SAC_CONTRACT_ID) assertUsdcPaymentToken(network, env.USDC_SAC_CONTRACT_ID);

  const registryContractId = env.REGISTRY_CONTRACT_ID || undefined;
  if (registryContractId && !StrKey.isValidContract(registryContractId)) {
    throw new Error(`REGISTRY_CONTRACT_ID is not a valid contract address: ${registryContractId}`);
  }

  return { network, profile, rpcUrl, registryContractId };
}
