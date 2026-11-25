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
  // No hay fuente real de disputas: `disputeCount` siempre es 0 (o un mock).
  // Neutralizamos el componente para no regalar 15 puntos por esa ausencia.
  test("sin pagos → 0", () => expect(claimsFactor(0, 0)).toBe(0));
  test("sin disputas reportadas → 0 (no otorga crédito)", () =>
    expect(claimsFactor(0, 100)).toBe(0));
  test("disputas simuladas → 0 (no penaliza con datos falsos)", () =>
    expect(claimsFactor(5, 10)).toBe(0));
  test("todos los pagos disputados → 0", () => expect(claimsFactor(10, 10)).toBe(0));
  test("más disputas que pagos (dato inconsistente) → 0", () =>
    expect(claimsFactor(15, 10)).toBe(0));
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

  test("provider ideal sin fuente de disputas → tope 85 (claims no aporta)", () => {
    const result = computeTrustScore({
      registeredAt: daysAgo(365),
      volume30dUsdc: 100_000,
      kybStatus: "verified",
      disputeCount: 0,
      paymentCount: 500,
      lastPaymentAt: daysAgo(0),
      now: NOW,
    });
    expect(result.components.claims).toBe(0);
    expect(result.score).toBe(85);
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
    expect(result.weights.claims).toBe(0.15);
    // claims neutralizado: no suma los 0.15 * 0.9 que sumaba antes.
    const expected = 0.15 * 0.5 + 0.3 * 0.5 + 0.3 * 0.3 + 0.15 * 0 + 0.1 * 0.5;
    expect(result.score).toBe(Math.round(100 * expected));
  });

  test("el score no cambia aunque cambien los datos de disputas", () => {
    const base = {
      registeredAt: daysAgo(45),
      volume30dUsdc: 99,
      kybStatus: "verified" as const,
      paymentCount: 10,
      lastPaymentAt: daysAgo(8),
      now: NOW,
    };
    const sinDisputas = computeTrustScore({ ...base, disputeCount: 0 });
    const conDisputas = computeTrustScore({ ...base, disputeCount: 9 });

    expect(sinDisputas.components.claims).toBe(0);
    expect(conDisputas.components.claims).toBe(0);
    expect(conDisputas.score).toBe(sinDisputas.score);
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
