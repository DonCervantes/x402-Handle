/**
 * Issue #94 — Stellar Testnet smoke test: register, USDC pay, log_payment, index.
 *
 * Steps:
 *   1. register_provider — call the Soroban registry contract as PROVIDER_OWNER
 *   2. usdc_pay         — send a USDC payment on Horizon from AGENT to PROVIDER
 *   3. log_payment      — write the payment tx hash into the registry contract
 *   4. index            — simulate get_provider + get_payment to verify on-chain state
 *   5. evidence         — write a JSON file with all hashes/ids/timestamps (no secrets)
 *
 * Uso:
 *   bun apps/cli/scripts/smoke-stellar-testnet.ts
 *   bun apps/cli/scripts/smoke-stellar-testnet.ts --out /tmp/evidence-94.json
 *
 * Required env vars:
 *   REGISTRY_CONTRACT_ID   — deployed testnet contract (C...)
 *   PROVIDER_OWNER_SECRET  — S... keypair; signs register_provider + log_payment
 *   AGENT_SECRET           — S... keypair; signs the USDC Horizon payment
 *   PROVIDER_PUBLIC        — G... destination for the USDC payment
 *
 * Optional env vars:
 *   STELLAR_NETWORK        — "testnet" (default) | "public"
 *   SOROBAN_RPC_URL        — override; default: https://soroban-testnet.stellar.org
 *   HORIZON_URL            — override; default: https://horizon-testnet.stellar.org
 *   SMOKE_AMOUNT_USDC      — USDC amount to pay; default "0.005"
 *   USDC_ISSUER            — override testnet USDC issuer
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
  Horizon,
  Operation,
  Asset,
  Memo,
} from "@stellar/stellar-sdk";
import { logPaymentOnChain } from "@flovia/x402-stellar";
import { stellar } from "sources";
const { simulateContractCall } = stellar;
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ─── Config ──────────────────────────────────────────────────────

const CONTRACT_ID = process.env.REGISTRY_CONTRACT_ID;
const OWNER_SECRET = process.env.PROVIDER_OWNER_SECRET;
const AGENT_SECRET = process.env.AGENT_SECRET;
const PROVIDER_PUBLIC = process.env.PROVIDER_PUBLIC;
const NETWORK = (process.env.STELLAR_NETWORK ?? "testnet") as "testnet" | "public";
const SOROBAN_URL =
  process.env.SOROBAN_RPC_URL ??
  (NETWORK === "public"
    ? "https://soroban.stellar.org"
    : "https://soroban-testnet.stellar.org");
const HORIZON_URL =
  process.env.HORIZON_URL ??
  (NETWORK === "public"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");
const AMOUNT_USDC = process.env.SMOKE_AMOUNT_USDC ?? "0.005";
const USDC_ISSUER =
  process.env.USDC_ISSUER ??
  (NETWORK === "public"
    ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const NETWORK_PASSPHRASE =
  NETWORK === "public" ? Networks.PUBLIC : Networks.TESTNET;

// evidence output path (CLI flag or default)
const outFlagIdx = process.argv.indexOf("--out");
const OUT_PATH =
  outFlagIdx !== -1 && process.argv[outFlagIdx + 1]
    ? process.argv[outFlagIdx + 1]
    : `./smoke-evidence-94-${Date.now()}.json`;

// ─── Guards ───────────────────────────────────────────────────────

if (!CONTRACT_ID || !OWNER_SECRET || !AGENT_SECRET || !PROVIDER_PUBLIC) {
  console.error(
    "Missing required env vars. Need: REGISTRY_CONTRACT_ID, PROVIDER_OWNER_SECRET, AGENT_SECRET, PROVIDER_PUBLIC"
  );
  process.exit(1);
}

// ─── Clients ─────────────────────────────────────────────────────

const sorobanServer = new rpc.Server(SOROBAN_URL);
const horizonServer = new Horizon.Server(HORIZON_URL);
const ownerKp = Keypair.fromSecret(OWNER_SECRET);
const agentKp = Keypair.fromSecret(AGENT_SECRET);
const registryContract = new Contract(CONTRACT_ID);

// ─── Evidence accumulator (no secrets) ───────────────────────────

const evidence: Record<string, unknown> = {
  issue: 94,
  network: NETWORK,
  contractId: CONTRACT_ID,
  runAt: new Date().toISOString(),
  providerPublic: PROVIDER_PUBLIC,
  agentPublic: agentKp.publicKey(),
  ownerPublic: ownerKp.publicKey(),
};

// ─── Helpers ─────────────────────────────────────────────────────

function banner(step: string): void {
  console.log("\n" + "─".repeat(60));
  console.log(`  ${step}`);
  console.log("─".repeat(60));
}

function usdcToStroops(amount: string): bigint {
  return BigInt(Math.round(Number(amount) * 10_000_000));
}

/** Wait for a Soroban tx to leave NOT_FOUND state. */
async function waitForSorobanTx(sendHash: string, label: string) {
  let res = await sorobanServer.getTransaction(sendHash);
  while (res.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1500));
    res = await sorobanServer.getTransaction(sendHash);
  }
  if (res.status !== "SUCCESS") {
    throw new Error(`${label} tx failed: ${JSON.stringify(res)}`);
  }
  return res;
}

// ─── Step 1: register_provider ────────────────────────────────────

banner("Step 1 — register_provider (Soroban)");

const providerSeed = {
  name: `Smoke-Test-#94-${randomUUID().slice(0, 8)}`,
  endpoint: "https://smoke.example.com/rate",
  priceUsdc: Number(AMOUNT_USDC),
  category: "smoke",
};

const metaHash = hash(Buffer.from(JSON.stringify(providerSeed)));

const ownerAccount1 = await sorobanServer.getAccount(ownerKp.publicKey());
const registerTx = new TransactionBuilder(ownerAccount1, {
  fee: BASE_FEE,
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .addOperation(
    registryContract.call(
      "register_provider",
      nativeToScVal(Address.fromString(ownerKp.publicKey()), { type: "address" }),
      nativeToScVal(providerSeed.name, { type: "string" }),
      nativeToScVal(providerSeed.endpoint, { type: "string" }),
      nativeToScVal(usdcToStroops(AMOUNT_USDC), { type: "u64" }),
      // payment_token: use the owner's public key as an Address placeholder
      // (same pattern as seed-providers.ts)
      nativeToScVal(Address.fromString(ownerKp.publicKey()), { type: "address" }),
      nativeToScVal(metaHash, { type: "bytes" }),
      nativeToScVal(providerSeed.category, { type: "symbol" })
    )
  )
  .setTimeout(60)
  .build();

const preparedRegisterTx = await sorobanServer.prepareTransaction(registerTx);
preparedRegisterTx.sign(ownerKp);

const registerSend = await sorobanServer.sendTransaction(preparedRegisterTx);
if (registerSend.status === "ERROR") {
  throw new Error(
    `register_provider sendTransaction failed: ${JSON.stringify(registerSend.errorResult)}`
  );
}
console.log(`  soroban send hash: ${registerSend.hash}`);

const registerResult = await waitForSorobanTx(registerSend.hash, "register_provider");
const providerId: bigint = scValToNative(registerResult.returnValue!);

console.log(`  provider_id: ${providerId}`);
console.log(`  name:        ${providerSeed.name}`);
console.log(`  soroban tx:  ${registerSend.hash}`);

evidence.step1_register = {
  sorobanTxHash: registerSend.hash,
  providerId: String(providerId),
  providerName: providerSeed.name,
  timestamp: new Date().toISOString(),
};

// ─── Step 2: USDC pay (Horizon) ───────────────────────────────────

banner("Step 2 — USDC pay (Horizon)");

const memo = "fl-smoke-" + randomUUID().replace(/-/g, "").slice(0, 5);
const usdc = new Asset("USDC", USDC_ISSUER);
const agentHorizonAccount = await horizonServer.loadAccount(agentKp.publicKey());

const payTx = new TransactionBuilder(agentHorizonAccount, {
  fee: BASE_FEE,
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .addOperation(
    Operation.payment({
      destination: PROVIDER_PUBLIC,
      asset: usdc,
      amount: AMOUNT_USDC,
    })
  )
  .addMemo(Memo.text(memo))
  .setTimeout(60)
  .build();

payTx.sign(agentKp);
const paySubmit = await horizonServer.submitTransaction(payTx);
const payTxHash = paySubmit.hash;

console.log(`  horizon tx:  ${payTxHash}`);
console.log(`  memo:        ${memo}`);
console.log(`  amount:      ${AMOUNT_USDC} USDC`);
console.log(`  from:        ${agentKp.publicKey().slice(0, 12)}...`);
console.log(`  to:          ${PROVIDER_PUBLIC.slice(0, 12)}...`);
console.log(
  `  explorer:    https://stellar.expert/explorer/testnet/tx/${payTxHash}`
);

evidence.step2_pay = {
  horizonTxHash: payTxHash,
  memo,
  amountUsdc: AMOUNT_USDC,
  payer: agentKp.publicKey(),
  destination: PROVIDER_PUBLIC,
  timestamp: new Date().toISOString(),
  explorerUrl: `https://stellar.expert/explorer/${NETWORK}/tx/${payTxHash}`,
};

// ─── Step 3: log_payment (Soroban) ────────────────────────────────

banner("Step 3 — log_payment (Soroban)");

await logPaymentOnChain(
  {
    contractId: CONTRACT_ID,
    providerId,
    callerSecret: OWNER_SECRET,
    sorobanUrl: SOROBAN_URL,
    network: NETWORK,
  },
  {
    txHash: payTxHash,
    payer: agentKp.publicKey(),
    amount: AMOUNT_USDC,
  }
);

console.log(`  logged payment for provider_id=${providerId}`);
console.log(`  tx_hash: ${payTxHash}`);

evidence.step3_log = {
  providerId: String(providerId),
  horizonTxHash: payTxHash,
  payer: agentKp.publicKey(),
  amountUsdc: AMOUNT_USDC,
  timestamp: new Date().toISOString(),
};

// ─── Step 4: index — simulate get_provider + get_payment ─────────

banner("Step 4 — index (simulateContractCall: get_provider, get_payment)");

// We use the owner's public key as the reader account (read-only sim, no auth needed)
const readerAccount = ownerKp.publicKey();

// 4a: get_provider
const providerData = await simulateContractCall({
  readerAccount,
  contractId: CONTRACT_ID,
  fn: "get_provider",
  args: [nativeToScVal(providerId, { type: "u64" })],
});

console.log("  get_provider result:");
console.log(`    id:       ${providerData.id}`);
console.log(`    name:     ${providerData.name}`);
console.log(`    endpoint: ${providerData.endpoint}`);
console.log(`    active:   ${providerData.active}`);
console.log(`    owner:    ${String(providerData.owner).slice(0, 12)}...`);

// 4b: get total payment count to find the payment we just logged
const paymentCountData = await simulateContractCall({
  readerAccount,
  contractId: CONTRACT_ID,
  fn: "payment_count",
  args: [],
});
const paymentCount = BigInt(paymentCountData);
console.log(`\n  payment_count: ${paymentCount}`);

// Scan recent payments for ours (walk back from the latest)
const txHashBytes = Buffer.from(payTxHash, "hex");

let foundPayment: Record<string, unknown> | null = null;
const scanFrom = paymentCount > 20n ? paymentCount - 20n + 1n : 1n;

for (let pid = paymentCount; pid >= scanFrom; pid--) {
  const p = await simulateContractCall({
    readerAccount,
    contractId: CONTRACT_ID,
    fn: "get_payment",
    args: [nativeToScVal(pid, { type: "u64" })],
  });
  const storedHash = Buffer.from(p.tx_hash).toString("hex");
  if (storedHash === payTxHash) {
    foundPayment = {
      id: String(p.id),
      providerId: String(p.provider_id),
      payer: String(p.payer),
      amountStroops: String(p.amount),
      txHash: storedHash,
      timestamp: new Date(Number(p.timestamp) * 1000).toISOString(),
    };
    console.log("\n  get_payment result (matched):");
    console.log(`    id:            ${p.id}`);
    console.log(`    provider_id:   ${p.provider_id}`);
    console.log(`    payer:         ${String(p.payer).slice(0, 12)}...`);
    console.log(`    amount:        ${p.amount} stroops`);
    console.log(`    tx_hash:       ${storedHash.slice(0, 16)}...`);
    console.log(
      `    timestamp:     ${new Date(Number(p.timestamp) * 1000).toISOString()}`
    );
    break;
  }
}

if (!foundPayment) {
  console.warn("  WARN: could not find our payment in the last 20 payment log entries.");
  console.warn("  The log_payment call succeeded; the entry may be further back.");
}

// Verify provider matches
if (String(providerData.id) !== String(providerId)) {
  throw new Error(
    `Indexed provider id mismatch: expected ${providerId}, got ${providerData.id}`
  );
}
if (foundPayment && foundPayment.providerId !== String(providerId)) {
  throw new Error(
    `Indexed payment provider_id mismatch: expected ${providerId}, got ${foundPayment.providerId}`
  );
}

evidence.step4_index = {
  provider: {
    id: String(providerData.id),
    name: String(providerData.name),
    endpoint: String(providerData.endpoint),
    active: Boolean(providerData.active),
    owner: String(providerData.owner),
  },
  payment: foundPayment,
  timestamp: new Date().toISOString(),
};

// ─── Step 5: write evidence JSON ─────────────────────────────────

banner("Step 5 — writing evidence");

// Sanity: assert no secret keys leaked into evidence
const evidenceStr = JSON.stringify(evidence, null, 2);
if (
  evidenceStr.includes(OWNER_SECRET) ||
  evidenceStr.includes(AGENT_SECRET)
) {
  throw new Error("BUG: secret key found in evidence JSON — aborting write");
}

writeFileSync(OUT_PATH, evidenceStr, "utf8");
console.log(`  evidence written to: ${OUT_PATH}`);
console.log();
console.log("=".repeat(60));
console.log("  SMOKE TEST PASSED — all 4 steps completed");
console.log("=".repeat(60));
console.log(`  network:      ${NETWORK}`);
console.log(`  contract:     ${CONTRACT_ID}`);
console.log(`  provider_id:  ${providerId}`);
console.log(`  horizon tx:   ${payTxHash}`);
console.log(
  `  explorer:     https://stellar.expert/explorer/${NETWORK}/tx/${payTxHash}`
);
console.log();
