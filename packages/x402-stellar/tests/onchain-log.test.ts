import { beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Test doubles for @stellar/stellar-sdk ─────────────────────────────────
// mock.module() es process-global pero bun corre cada archivo de test en su
// propio proceso, así que el stub no se filtra a otros archivos.

let getTransactionStatuses: Array<Record<string, unknown> & { status: string }>;
let sendTransactionResult: { status: string; hash: string; errorResult?: unknown };
let getTransactionCalls = 0;

mock.module("@stellar/stellar-sdk", () => {
  class FakeServer {
    async getAccount() {
      return { id: "GFAKEACCOUNT" };
    }
    async prepareTransaction(tx: unknown) {
      return { ...(tx as object), sign: () => {} };
    }
    async sendTransaction() {
      return sendTransactionResult;
    }
    async getTransaction() {
      getTransactionCalls += 1;
      const next = getTransactionStatuses.shift();
      // Si no quedan statuses programados, la tx nunca aparece.
      return next ?? { status: "NOT_FOUND" };
    }
  }

  return {
    rpc: { Server: FakeServer },
    Contract: class {
      call() {
        return {};
      }
    },
    TransactionBuilder: class {
      addOperation() {
        return this;
      }
      setTimeout() {
        return this;
      }
      build() {
        return {};
      }
    },
    BASE_FEE: "100",
    Networks: {
      PUBLIC: "Public Global Stellar Network ; September 2015",
      TESTNET: "Test SDF Network ; September 2015",
    },
    Keypair: {
      fromSecret: () => ({ publicKey: () => "GFAKEACCOUNT", sign: () => {} }),
    },
    Address: { fromString: (value: string) => ({ toString: () => value }) },
    nativeToScVal: (value: unknown) => value,
  };
});

const { logPaymentOnChain } = await import("../src/onchain-log");

const baseOpts = {
  contractId: "CCONTRACT",
  providerId: 1n,
  callerSecret: "SFAKESECRET",
  network: "testnet" as const,
};
const payment = { txHash: "aabbccdd", payer: "GPAYER", amount: "0.005" };

beforeEach(() => {
  getTransactionStatuses = [];
  getTransactionCalls = 0;
  sendTransactionResult = { status: "PENDING", hash: "deadbeef" };
});

describe("logPaymentOnChain", () => {
  test("resuelve cuando la tx llega a SUCCESS", async () => {
    getTransactionStatuses = [
      { status: "NOT_FOUND" },
      { status: "NOT_FOUND" },
      { status: "SUCCESS" },
    ];

    await expect(
      logPaymentOnChain({ ...baseOpts, pollIntervalMs: 5 }, payment),
    ).resolves.toBeUndefined();
    expect(getTransactionCalls).toBe(3);
  });

  test("falla rápido cuando sendTransaction devuelve ERROR", async () => {
    sendTransactionResult = {
      status: "ERROR",
      hash: "deadbeef",
      errorResult: { code: "tx_failed" },
    };

    await expect(logPaymentOnChain(baseOpts, payment)).rejects.toThrow("sendTransaction failed");
    expect(getTransactionCalls).toBe(0);
  });

  test("lanza cuando la tx termina en FAILED", async () => {
    getTransactionStatuses = [{ status: "FAILED", result: {} }];

    await expect(logPaymentOnChain(baseOpts, payment)).rejects.toThrow("log_payment tx failed");
  });

  test("abandona tras maxGetTransactionAttempts si la tx nunca aparece", async () => {
    await expect(
      logPaymentOnChain({ ...baseOpts, maxGetTransactionAttempts: 3, pollIntervalMs: 5 }, payment),
    ).rejects.toThrow(/not confirmed on Soroban/);
    expect(getTransactionCalls).toBe(3);
  });

  test("abandona tras confirmationTimeoutMs aunque queden intentos", async () => {
    const startedAt = Date.now();

    await expect(
      logPaymentOnChain(
        {
          ...baseOpts,
          maxGetTransactionAttempts: 100,
          confirmationTimeoutMs: 40,
          pollIntervalMs: 10,
        },
        payment,
      ),
    ).rejects.toThrow(/not confirmed on Soroban/);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(getTransactionCalls).toBeLessThan(100);
  });
});
