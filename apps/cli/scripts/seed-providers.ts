/**
 * Ticket 3.3 — siembra 5 providers demo realistas en el registry on-chain.
 *
 * Uso:
 *   bun --env-file=.env apps/cli/scripts/seed-providers.ts
 *
 * Requiere en .env: REGISTRY_CONTRACT_ID, DEMO_PROVIDER_PUBLIC/SECRET,
 * SOROBAN_RPC_URL, STELLAR_NETWORK, USDC_ASSET_ISSUER.
 */
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Keypair,
  Address,
  nativeToScVal,
  scValToNative,
  hash,
} from "@stellar/stellar-sdk";
import { requireRegistryContractId } from "@flovia/x402-stellar";

const CONTRACT_ID = requireRegistryContractId();
const OWNER_SECRET = process.env.DEMO_PROVIDER_SECRET;
const SOROBAN_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
// payment_token espera un contrato Address; usamos el del propio owner como
// placeholder demo (no se usa para mover fondos, sólo metadata on-chain).
const PAYMENT_TOKEN_PLACEHOLDER = process.env.DEMO_PROVIDER_PUBLIC!;

if (!OWNER_SECRET) {
  console.error("Missing DEMO_PROVIDER_SECRET in .env");
  process.exit(1);
}

const server = new rpc.Server(SOROBAN_URL);
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
        nativeToScVal(Address.fromString(PAYMENT_TOKEN_PLACEHOLDER), { type: "address" }),
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

console.log(`Seeding ${PROVIDERS.length} providers into ${CONTRACT_ID}...\n`);

for (const seed of PROVIDERS) {
  const id = await registerProvider(seed);
  console.log(`  [${id}] ${seed.name} — ${seed.priceUsdc} USDC/call — ${seed.endpoint}`);
}

console.log("\nDone.");
