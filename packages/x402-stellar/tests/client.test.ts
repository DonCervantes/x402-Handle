import { describe, expect, test } from "bun:test";
import {
  X402ConfirmationTimeoutError,
  X402TransactionFailedError,
  X402TransactionNotFoundError,
  waitForConfirmation,
  type HorizonProbe,
  type HorizonProbeResult,
} from "../src/client";

const TX_HASH = "abc123";

const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

const scripted = (results: HorizonProbeResult[]): HorizonProbe => {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)] as HorizonProbeResult;
};

describe("waitForConfirmation", () => {
  test("returns as soon as Horizon reports the tx as successful", async () => {
    const time = clock();
    const probe = scripted([{ status: "success" }]);

    await expect(
      waitForConfirmation(probe, { txHash: TX_HASH, timeoutMs: 30_000, ...time }),
    ).resolves.toBeUndefined();
    expect(time.now()).toBe(0);
  });

  test("keeps polling while Horizon has not indexed the tx yet", async () => {
    const time = clock();
    let calls = 0;
    const probe: HorizonProbe = async () => {
      calls += 1;
      return calls < 3 ? { status: "not_found" } : { status: "success" };
    };

    await waitForConfirmation(probe, {
      txHash: TX_HASH,
      timeoutMs: 30_000,
      pollIntervalMs: 500,
      ...time,
    });

    expect(calls).toBe(3);
    expect(time.now()).toBe(1_000);
  });

  test("surfaces not-found when Horizon keeps answering 404 until the deadline", async () => {
    const time = clock();
    const probe = scripted([{ status: "not_found" }]);

    const error = await waitForConfirmation(probe, {
      txHash: TX_HASH,
      timeoutMs: 3_000,
      pollIntervalMs: 1_000,
      ...time,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(X402TransactionNotFoundError);
    const notFound = error as X402TransactionNotFoundError;
    expect(notFound.code).toBe("transaction_not_found");
    expect(notFound.txHash).toBe(TX_HASH);
    expect(notFound.attempts).toBe(3);
  });

  test("surfaces a timeout when Horizon never answers conclusively", async () => {
    const time = clock();
    const probe = scripted([{ status: "error", message: "ECONNRESET" }]);

    const error = await waitForConfirmation(probe, {
      txHash: TX_HASH,
      timeoutMs: 3_000,
      pollIntervalMs: 1_000,
      ...time,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(X402ConfirmationTimeoutError);
    const timeout = error as X402ConfirmationTimeoutError;
    expect(timeout.code).toBe("confirmation_timeout");
    expect(timeout.timeoutMs).toBe(3_000);
    expect(timeout.message).toContain("ECONNRESET");
  });

  test("distinguishes timeout from not-found for the same window", async () => {
    const timeoutClock = clock();
    const notFoundClock = clock();

    const timeoutError = await waitForConfirmation(scripted([{ status: "error", message: "x" }]), {
      txHash: TX_HASH,
      timeoutMs: 1_000,
      pollIntervalMs: 500,
      ...timeoutClock,
    }).catch((cause: unknown) => cause);

    const notFoundError = await waitForConfirmation(scripted([{ status: "not_found" }]), {
      txHash: TX_HASH,
      timeoutMs: 1_000,
      pollIntervalMs: 500,
      ...notFoundClock,
    }).catch((cause: unknown) => cause);

    expect(timeoutError).toBeInstanceOf(X402ConfirmationTimeoutError);
    expect(notFoundError).toBeInstanceOf(X402TransactionNotFoundError);
    expect((timeoutError as Error).name).not.toBe((notFoundError as Error).name);
  });

  test("fails fast when the tx landed but was not successful", async () => {
    const time = clock();
    const probe = scripted([{ status: "failed", message: "tx_bad_seq" }]);

    const error = await waitForConfirmation(probe, {
      txHash: TX_HASH,
      timeoutMs: 30_000,
      ...time,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(X402TransactionFailedError);
    expect((error as X402TransactionFailedError).code).toBe("transaction_failed");
    expect(time.now()).toBe(0);
  });

  test("treats a thrown probe error as an inconclusive attempt", async () => {
    const time = clock();
    let calls = 0;
    const probe: HorizonProbe = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { status: "success" };
    };

    await waitForConfirmation(probe, { txHash: TX_HASH, timeoutMs: 30_000, ...time });
    expect(calls).toBe(2);
  });
});
