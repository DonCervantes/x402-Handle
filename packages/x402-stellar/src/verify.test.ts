import { describe, expect, test } from "bun:test";
import { evaluatePayment, verifyUsdcPayment } from "./verify";
import {
  DESTINATION,
  PAYER,
  PUBLIC_ISSUER,
  OTHER_ISSUER,
  TESTNET_ISSUER,
  makeHorizon,
  makeHorizonNotFound,
  validPayment,
  validTx,
} from "./test-fixtures";

const BASE_EXPECTED = {
  destination: DESTINATION,
  amountUsdc: "0.005",
  memo: "fl-deadbeef12",
  usdcIssuer: TESTNET_ISSUER,
};

function ops(payment = validPayment()) {
  return { records: [payment] };
}

describe("verify: memo binding", () => {
  test("acepta cuando el memo coincide (text)", () => {
    const res = evaluatePayment(
      validTx("fl-deadbeef12"),
      ops(),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(true);
  });

  test("rechaza cuando el memo difiere", () => {
    const res = evaluatePayment(
      validTx("fl-wrongmemo99"),
      ops(),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("memo_mismatch");
  });

  test("rechaza cuando el memo_type no es text", () => {
    const res = evaluatePayment(
      { successful: true, memo_type: "none", memo: "fl-deadbeef12" },
      ops(),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("memo_mismatch");
  });
});

describe("verify: underpayment", () => {
  test("rechaza cuando el monto es menor al esperado", () => {
    const res = evaluatePayment(
      validTx("fl-deadbeef12"),
      ops(validPayment({ amount: "0.004" })),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("underpayment");
  });

  test("acepta en el monto exacto", () => {
    const res = evaluatePayment(
      validTx("fl-deadbeef12"),
      ops(validPayment({ amount: "0.005" })),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(true);
  });

  test("acepta cuando el monto es mayor (sobrepago)", () => {
    const res = evaluatePayment(
      validTx("fl-deadbeef12"),
      ops(validPayment({ amount: "0.010" })),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(true);
  });
});

describe("verify: USDC issuer / asset", () => {
  test("rechaza cuando el issuer no coincide", () => {
    const res = evaluatePayment(
      validTx("fl-deadbeef12"),
      ops(validPayment({ asset_issuer: OTHER_ISSUER })),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("asset_mismatch");
  });

  test("rechaza cuando el asset no es USDC", () => {
    const res = evaluatePayment(
      validTx("fl-deadbeef12"),
      ops(validPayment({ asset_code: "USDT", asset_issuer: TESTNET_ISSUER })),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("asset_mismatch");
  });

  test("rechaza XLM nativo (asset nativo)", () => {
    const res = evaluatePayment(
      validTx("fl-deadbeef12"),
      ops(validPayment({ asset_type: "native", asset_code: undefined, asset_issuer: undefined })),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("asset_mismatch");
  });

  test("rechaza destino incorrecto", () => {
    const res = evaluatePayment(
      validTx("fl-deadbeef12"),
      ops(validPayment({ to: PAYER })),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("destination_mismatch");
  });

  test("usa el issuer de red por defecto cuando no se overridea", async () => {
    const horizon = makeHorizon(validTx("fl-deadbeef12"), validPayment({ asset_issuer: TESTNET_ISSUER }));
    const res = await verifyUsdcPayment({
      txHash: "abc",
      expected: { destination: DESTINATION, amountUsdc: "0.005", memo: "fl-deadbeef12", network: "testnet" },
      horizonServer: horizon,
    });
    expect(res.ok).toBe(true);
  });

  test("rechaza issuer de public cuando se espera testnet", async () => {
    const horizon = makeHorizon(validTx("fl-deadbeef12"), validPayment({ asset_issuer: PUBLIC_ISSUER }));
    const res = await verifyUsdcPayment({
      txHash: "abc",
      expected: { destination: DESTINATION, amountUsdc: "0.005", memo: "fl-deadbeef12", network: "testnet" },
      horizonServer: horizon,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("asset_mismatch");
  });
});

describe("verify: transacción on-chain", () => {
  test("rechaza tx fallida", () => {
    const res = evaluatePayment(
      { successful: false, memo_type: "text", memo: "fl-deadbeef12" },
      ops(),
      BASE_EXPECTED,
      "txhash"
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("tx_failed");
  });

  test("rechaza tx no encontrada en Horizon (404)", async () => {
    const res = await verifyUsdcPayment({
      txHash: "missing",
      expected: { destination: DESTINATION, amountUsdc: "0.005", memo: "fl-deadbeef12", network: "testnet" },
      horizonServer: makeHorizonNotFound(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("tx_not_found");
  });

  test("flujo completo contra Horizon doble: pago válido", async () => {
    const horizon = makeHorizon(validTx("fl-deadbeef12"), validPayment());
    const res = await verifyUsdcPayment({
      txHash: "txhash",
      expected: { destination: DESTINATION, amountUsdc: "0.005", memo: "fl-deadbeef12", network: "testnet" },
      horizonServer: horizon,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payer).toBe(PAYER);
      expect(res.amount).toBe("0.005");
      expect(res.memo).toBe("fl-deadbeef12");
    }
  });
});
