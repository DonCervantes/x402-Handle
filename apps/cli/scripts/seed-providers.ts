/**
 * Ticket 3.3 — siembra 5 providers demo realistas en el registry on-chain.
 *
 * Uso:
 *   bun --env-file=.env apps/cli/scripts/seed-providers.ts
 *
 * Requiere en .env: STELLAR_NETWORK (testnet|public), REGISTRY_CONTRACT_ID,
 * DEMO_PROVIDER_SECRET, and STELLAR_RPC_URL (required on public).
 * See contracts/soroban-registry/README.md#networks.
 *
 * payment_token is always the USDC SAC of STELLAR_NETWORK; a
 * USDC_SAC_CONTRACT_ID from the other network is rejected.
 */
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  Address,
  nativeToScVal,
  scValToNative,
  hash,
} from "@stellar/stellar-sdk";
import { assertUsdcPaymentToken, resolveStellarEnv } from "@flovia/x402-stellar/networks";

const stellar = resolveStellarEnv(process.env);
const CONTRACT_ID = stellar.registryContractId;
const OWNER_SECRET = process.env.DEMO_PROVIDER_SECRET;
const NETWORK_PASSPHRASE = stellar.profile.networkPassphrase;
const PAYMENT_TOKEN = stellar.profile.usdc.sacContractId;
assertUsdcPaymentToken(stellar.network, PAYMENT_TOKEN);

if (!CONTRACT_ID || !OWNER_SECRET) {
  console.error("Missing REGISTRY_CONTRACT_ID or DEMO_PROVIDER_SECRET in .env");
  process.exit(1);
}

const server = new rpc.Server(stellar.rpcUrl);
const owner = Keypair.fromSecret(OWNER_SECRET);
const contract = new Contract(CONTRACT_ID);

interface ProviderSeed {
  name: string;
  endpoint: string;
  priceUsdc: number; // se convierte a stroops (1 USDC = 10^7 stroops)
  category: string;
}

const PROVIDERS: ProviderSeed[] = [
  { name: "FX Rates Oracle", endpoint: "https://fx.example.com/rate", priceUsdc: 0.005, category: "fx" },
  { name: "Sentiment API", endpoint: "https://sentiment.ai/agent", priceUsdc: 0.01, category: "data" },
  { name: "On-chain Tx Lookup", endpoint: "https://txlookup.example.com/v1", priceUsdc: 0.003, category: "data" },
  { name: "Weather Forecast Feed", endpoint: "https://weather.example.com/forecast", priceUsdc: 0.002, category: "data" },
  { name: "Credit Risk Scorer", endpoint: "https://risk.example.com/score", priceUsdc: 0.02, category: "fintech" },
];

function usdcToStroops(amount: number): bigint {
  return BigInt(Math.round(amount * 10_000_000));
}

async function registerProvider(seed: ProviderSeed): Promise<bigint> {
  const account = await server.getAccount(owner.publicKey());

  const metadataHash = hash(Buffer.from(JSON.stringify(seed)));

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      contract.call(
        "register_provider",
        nativeToScVal(Address.fromString(owner.publicKey()), { type: "address" }),
        nativeToScVal(seed.name, { type: "string" }),
        nativeToScVal(seed.endpoint, { type: "string" }),
        nativeToScVal(usdcToStroops(seed.priceUsdc), { type: "u64" }),
        nativeToScVal(Address.fromString(PAYMENT_TOKEN), { type: "address" }),
        nativeToScVal(metadataHash, { type: "bytes" }),
        nativeToScVal(seed.category, { type: "symbol" })
      )
    )
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(owner);

  const sendRes = await server.sendTransaction(prepared);
  if (sendRes.status === "ERROR") {
    throw new Error(`sendTransaction failed: ${JSON.stringify(sendRes.errorResult)}`);
  }

  let getRes = await server.getTransaction(sendRes.hash);
  while (getRes.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    getRes = await server.getTransaction(sendRes.hash);
  }
  if (getRes.status !== "SUCCESS") {
    throw new Error(`tx failed: ${JSON.stringify(getRes)}`);
  }

  const providerId = scValToNative(getRes.returnValue!);
  return providerId;
}

console.log(
  `Seeding ${PROVIDERS.length} providers into ${CONTRACT_ID} on ${stellar.profile.label} (payment_token ${PAYMENT_TOKEN})...\n`,
);

for (const seed of PROVIDERS) {
  const id = await registerProvider(seed);
  console.log(`  [${id}] ${seed.name} — ${seed.priceUsdc} USDC/call — ${seed.endpoint}`);
}

console.log("\nDone.");
