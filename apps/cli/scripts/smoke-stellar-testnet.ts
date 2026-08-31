import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  hash,
  Horizon,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { loadStellarConfig } from "contracts";

const config = loadStellarConfig();
if (config.network !== "testnet") {
  throw new Error("This smoke test only runs with STELLAR_NETWORK=testnet");
}

const ownerSecret = process.env.SMOKE_OWNER_SECRET;
const payerSecret = process.env.SMOKE_PAYER_SECRET;
const providerDestination = process.env.SMOKE_PROVIDER_PUBLIC;
const usdcSacContractId = process.env.SMOKE_USDC_SAC_CONTRACT_ID;
const databaseUrl = process.env.DATABASE_URL;
const usdcIssuer = process.env.USDC_ASSET_ISSUER ??
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const amountUsdc = process.env.SMOKE_PAYMENT_AMOUNT ?? "0.0050000";

if (!ownerSecret || !payerSecret || !providerDestination || !usdcSacContractId || !databaseUrl) {
  throw new Error(
    "Missing SMOKE_OWNER_SECRET, SMOKE_PAYER_SECRET, SMOKE_PROVIDER_PUBLIC, SMOKE_USDC_SAC_CONTRACT_ID, or DATABASE_URL",
  );
}

const owner = Keypair.fromSecret(ownerSecret);
const payer = Keypair.fromSecret(payerSecret);
const horizon = new Horizon.Server(
  process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
);
const soroban = new rpc.Server(config.sorobanRpcUrl);
const registry = new Contract(config.registryContractId);

async function submitSoroban(source: Keypair, operation: any): Promise<any> {
  const account = await soroban.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  const prepared = await soroban.prepareTransaction(tx);
  prepared.sign(source);
  const sent = await soroban.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`Soroban transaction rejected: ${JSON.stringify(sent.errorResult)}`);
  }

  const deadline = Date.now() + 60_000;
  let result = await soroban.getTransaction(sent.hash);
  while (result.status === "NOT_FOUND") {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${sent.hash}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    result = await soroban.getTransaction(sent.hash);
  }
  if (result.status !== "SUCCESS") {
    throw new Error(`Soroban transaction failed: ${JSON.stringify(result)}`);
  }
  return { hash: sent.hash, result };
}

async function submitUsdcPayment(): Promise<string> {
  const account = await horizon.loadAccount(payer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({
        destination: providerDestination!,
        asset: new Asset("USDC", usdcIssuer),
        amount: amountUsdc,
      }),
    )
    .setTimeout(120)
    .build();
  tx.sign(payer);
  return (await horizon.submitTransaction(tx)).hash;
}

async function runIndexer(): Promise<void> {
  const child = Bun.spawn(["bun", "apps/cli/indexer.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl!, STELLAR_NETWORK: "testnet" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Indexer exited with code ${exitCode}`);
}

async function assertIndexed(providerId: bigint, paymentHash: string, deactivated: boolean): Promise<void> {
  const providerRows = await Bun.sql`
    SELECT active FROM providers
    WHERE id = ${`${config.registryContractId}/${providerId}`}
      AND contract_id = ${config.registryContractId}
  `;
  const paymentRows = await Bun.sql`
    SELECT tx_hash FROM payments WHERE tx_hash = ${paymentHash}
  `;
  if (providerRows.length !== 1 || paymentRows.length !== 1) {
    throw new Error("Indexer did not persist prov_reg and pay_log");
  }
  if (deactivated && providerRows[0].active !== false) {
    throw new Error("Indexer did not persist prov_off");
  }
}

const registration = await submitSoroban(
  owner,
  registry.call(
    "register_provider",
    nativeToScVal(Address.fromString(owner.publicKey()), { type: "address" }),
    nativeToScVal("Testnet smoke provider", { type: "string" }),
    nativeToScVal("https://smoke.invalid/api", { type: "string" }),
    nativeToScVal(50_000n, { type: "u64" }),
    nativeToScVal(Address.fromString(usdcSacContractId), { type: "address" }),
    nativeToScVal(hash(Buffer.from(`smoke:${Date.now()}`)), { type: "bytes" }),
    nativeToScVal("smoke", { type: "symbol" }),
  ),
);
const providerId = BigInt(scValToNative(registration.result.returnValue));
const paymentHash = await submitUsdcPayment();
const paymentHashBytes = Buffer.from(paymentHash, "hex");
const amountStroops = BigInt(Math.round(Number(amountUsdc) * 10_000_000));

const logOperation = () => registry.call(
  "log_payment",
  nativeToScVal(providerId, { type: "u64" }),
  nativeToScVal(Address.fromString(payer.publicKey()), { type: "address" }),
  nativeToScVal(amountStroops, { type: "u64" }),
  nativeToScVal(paymentHashBytes, { type: "bytes" }),
);
const logged = await submitSoroban(owner, logOperation());

let duplicateRejected = false;
try {
  await submitSoroban(owner, logOperation());
} catch {
  duplicateRejected = true;
}
if (!duplicateRejected) throw new Error("Duplicate tx_hash was accepted");

const deactivateTx = process.argv.includes("--deactivate")
  ? await submitSoroban(owner, registry.call("deactivate", nativeToScVal(providerId, { type: "u64" })))
  : null;
await runIndexer();
await assertIndexed(providerId, paymentHash, deactivateTx !== null);

console.log(JSON.stringify({
  contractId: config.registryContractId,
  network: config.network,
  owner: owner.publicKey(),
  payer: payer.publicKey(),
  providerId: providerId.toString(),
  registerTxHash: registration.hash,
  paymentTxHash: paymentHash,
  logPaymentTxHash: logged.hash,
  deactivateTxHash: deactivateTx?.hash ?? null,
  duplicateRejected,
  deactivated: process.argv.includes("--deactivate"),
}, null, 2));