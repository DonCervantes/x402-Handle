import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair, rpc, scValToNative, Transaction } from "@stellar/stellar-sdk";
import { logPaymentOnChain } from "../src/onchain-log";

afterEach(() => mock.restore());

test("logs with the signer as the authenticated caller and preserves payment arguments", async () => {
  const caller = Keypair.random();
  const payer = Keypair.random().publicKey();
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const txHash = "ab".repeat(32);
  const stop = new Error("stop before network submission");
  spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(caller.publicKey(), "1"));
  spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => {
    if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
    return tx;
  });
  const send = spyOn(rpc.Server.prototype, "sendTransaction").mockRejectedValue(stop);

  await expect(
    logPaymentOnChain(
      { contractId, providerId: 7n, callerSecret: caller.secret() },
      { txHash, payer, amount: "0.005" },
    ),
  ).rejects.toThrow(stop.message);

  const tx = send.mock.calls[0]?.[0];
  if (!(tx instanceof Transaction)) throw new Error("expected a signed transaction");
  const operation = tx.operations[0];
  if (operation?.type !== "invokeHostFunction") throw new Error("expected a contract invocation");
  const invocation = operation.func.invokeContract();
  expect(invocation.functionName().toString()).toBe("log_payment");
  const args = invocation.args();
  expect(args).toHaveLength(5);
  expect(scValToNative(args[0]!)).toBe(caller.publicKey());
  expect(scValToNative(args[1]!)).toBe(7n);
  expect(scValToNative(args[2]!)).toBe(payer);
  expect(scValToNative(args[3]!)).toBe(50_000n);
  expect(Buffer.from(scValToNative(args[4]!)).toString("hex")).toBe(txHash);
  expect(tx.source).toBe(caller.publicKey());
  expect(tx.signatures).toHaveLength(1);
  expect(caller.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
});
