/** Read the single registry contract configuration shared by all services. */
export function getRegistryContractId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const contractId = env.REGISTRY_CONTRACT_ID?.trim();
  return contractId || undefined;
}

/** Require a configured registry before making an on-chain request. */
export function requireRegistryContractId(env: NodeJS.ProcessEnv = process.env): string {
  const contractId = getRegistryContractId(env);
  if (!contractId) {
    throw new Error(
      "REGISTRY_CONTRACT_ID is required for registry on-chain operations; configure the deployed Soroban contract ID",
    );
  }
  return contractId;
}
