import { describe, expect, test } from "bun:test";
import { createReplayCache } from "./replay-cache";

describe("replay-cache: replay protection", () => {
  test("una tx consumida se detecta como ya usada", () => {
    const cache = createReplayCache();
    expect(cache.has("tx1")).toBe(false);
    cache.add("tx1");
    expect(cache.has("tx1")).toBe(true);
    expect(cache.size()).toBe(1);
  });

  test("dos tx distintas no colisionan", () => {
    const cache = createReplayCache();
    cache.add("tx1");
    expect(cache.has("tx2")).toBe(false);
    cache.add("tx2");
    expect(cache.has("tx1")).toBe(true);
    expect(cache.has("tx2")).toBe(true);
  });

  test("la segunda verificación del mismo tx es rechazada (replay)", () => {
    const cache = createReplayCache();
    cache.add("replayed");
    // Semánticamente: el middleware consulta has() antes de admitir.
    expect(cache.has("replayed")).toBe(true);
  });
});

describe("replay-cache: TTL / expiry", () => {
  test("una entrada expirada deja de considerarse consumida", () => {
    // TTL de 1ms y avanzamos el reloj manualmente.
    const cache = createReplayCache({ ttlMs: 1 });
    cache.add("expired");
    expect(cache.has("expired")).toBe(true);

    // Forzamos el paso del tiempo durmiendo > TTL.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.has("expired")).toBe(false);
        resolve();
      }, 5);
    });
  });

  test("purga lazy al insertar una entrada nueva", () => {
    const cache = createReplayCache({ ttlMs: 1 });
    cache.add("old");
    // Esperamos a que expire.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cache.add("new");
        expect(cache.has("old")).toBe(false);
        expect(cache.has("new")).toBe(true);
        resolve();
      }, 5);
    });
  });
});
