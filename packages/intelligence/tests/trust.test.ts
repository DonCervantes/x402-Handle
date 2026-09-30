import { describe, expect, test } from "bun:test";
import {
  ageFactor,
  claimsFactor,
  computeTrustScore,
  kybFactor,
  recencyFactor,
  volumeFactor,
} from "../src/trust";

const NOW = new Date("2026-06-30T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe("ageFactor", () => {
  test("0 días → 0", () => expect(ageFactor(NOW, NOW)).toBe(0));
  test("45 días → 0.5", () => expect(ageFactor(daysAgo(45), NOW)).toBeCloseTo(0.5, 5));
  test("90 días → 1 (cap)", () => expect(ageFactor(daysAgo(90), NOW)).toBe(1));
  test("180 días → 1 (no excede el cap)", () => expect(ageFactor(daysAgo(180), NOW)).toBe(1));
});

describe("volumeFactor", () => {
  test("0 volumen → 0", () => expect(volumeFactor(0)).toBe(0));
  test("volumen negativo → 0 (clamp)", () => expect(volumeFactor(-100)).toBe(0));
  test("9999 USDC → log10(10000)/4 = 1 (cap)", () => expect(volumeFactor(9999)).toBeCloseTo(1, 5));
  test("99 USDC → log10(100)/4 = 0.5", () => expect(volumeFactor(99)).toBeCloseTo(0.5, 5));
});

describe("kybFactor", () => {
  test("verified → 1.0", () => expect(kybFactor("verified")).toBe(1.0));
  test("pending → 0.3", () => expect(kybFactor("pending")).toBe(0.3));
  test("none → 0", () => expect(kybFactor("none")).toBe(0));
});

describe("claimsFactor", () => {
  test("neutralizado a 0 hasta que exista sistema de disputas", () => {
    expect(claimsFactor(0, 0)).toBe(0);
    expect(claimsFactor(0, 100)).toBe(0);
    expect(claimsFactor(5, 10)).toBe(0);
    expect(claimsFactor(10, 10)).toBe(0);
    expect(claimsFactor(15, 10)).toBe(0);
  });
});

describe("recencyFactor", () => {
  test("sin pagos nunca → 0", () => expect(recencyFactor(null, NOW)).toBe(0));
  test("pago hace 1 día → 1.0", () => expect(recencyFactor(daysAgo(1), NOW)).toBe(1.0));
  test("pago hace exactamente 7 días → 1.0 (límite inclusive)", () =>
    expect(recencyFactor(daysAgo(7), NOW)).toBe(1.0));
  test("pago hace 8 días → 0.5", () => expect(recencyFactor(daysAgo(8), NOW)).toBe(0.5));
  test("pago hace exactamente 30 días → 0.5 (límite inclusive)", () =>
    expect(recencyFactor(daysAgo(30), NOW)).toBe(0.5));
  test("pago hace 31 días → 0", () => expect(recencyFactor(daysAgo(31), NOW)).toBe(0));
});

describe("computeTrustScore", () => {
  test("provider nuevo, sin volumen, sin KYB, sin pagos → score bajo", () => {
    const result = computeTrustScore({
      registeredAt: NOW,
      volume30dUsdc: 0,
      kybStatus: "none",
      disputeCount: 0,
      paymentCount: 0,
      lastPaymentAt: null,
      now: NOW,
    });
    expect(result.score).toBe(0);
  });

  test("provider ideal: viejo, alto volumen, KYB verified, sin disputas, activo hoy → score alto con claims neutralizado", () => {
    const result = computeTrustScore({
      registeredAt: daysAgo(365),
      volume30dUsdc: 100_000,
      kybStatus: "verified",
      disputeCount: 0,
      paymentCount: 500,
      lastPaymentAt: daysAgo(0),
      now: NOW,
    });
    // Con claims neutralizado (peso 0.15 = 0), el tope máximo es 85
    expect(result.score).toBe(85);
    expect(result.components.claims).toBe(0);
  });

  test("componentes y pesos quedan persistidos en el resultado para auditabilidad", () => {
    const result = computeTrustScore({
      registeredAt: daysAgo(45),
      volume30dUsdc: 99,
      kybStatus: "pending",
      disputeCount: 1,
      paymentCount: 10,
      lastPaymentAt: daysAgo(8),
      now: NOW,
    });
    expect(result.components.age).toBeCloseTo(0.5, 5);
    expect(result.components.volume).toBeCloseTo(0.5, 5);
    expect(result.components.kyb).toBe(0.3);
    expect(result.components.claims).toBe(0);
    expect(result.components.recency).toBe(0.5);
    expect(result.weights.volume).toBe(0.3);
    // 100 * (0.15*0.5 + 0.30*0.5 + 0.30*0.3 + 0.15*0 + 0.10*0.5) = 36.499999999999994 → round = 36
    expect(result.score).toBe(36);
  });

  test("score breakdown neutraliza claims y no presenta historial neutral como señal positiva", () => {
    const withHistory = computeTrustScore({
      registeredAt: daysAgo(90),
      volume30dUsdc: 1000,
      kybStatus: "verified",
      disputeCount: 0,
      paymentCount: 50,
      lastPaymentAt: daysAgo(5),
      now: NOW,
    });
    expect(withHistory.components.claims).toBe(0);
  });

  test("score siempre es un entero entre 0 y 100", () => {
    const result = computeTrustScore({
      registeredAt: daysAgo(10),
      volume30dUsdc: 3,
      kybStatus: "none",
      disputeCount: 2,
      paymentCount: 4,
      lastPaymentAt: daysAgo(40),
      now: NOW,
    });
    expect(Number.isInteger(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
