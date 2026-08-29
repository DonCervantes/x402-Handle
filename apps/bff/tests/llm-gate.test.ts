import { afterEach, describe, expect, test } from "bun:test";
import { createLlmGate } from "../src/http/llm-gate";

const envBackup = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envBackup)) delete process.env[key];
  }
  Object.assign(process.env, envBackup);
});

const llmRequest = (init: RequestInit = {}) =>
  new Request("http://bff/customers/0xabc/llm/upsell-explanation", init);

describe("createLlmGate", () => {
  test("returns 403 when no api key is configured", () => {
    const gate = createLlmGate({ env: { BFF_LLM_API_KEY: "" } });
    const rejection = gate(llmRequest());
    expect(rejection).not.toBeNull();
    expect(rejection?.status).toBe(403);
  });

  test("returns 401 for a missing or wrong key", () => {
    const env = { BFF_LLM_API_KEY: "secret" } as NodeJS.ProcessEnv;
    const gate = createLlmGate({ env });

    const missing = gate(llmRequest());
    const wrong = gate(llmRequest({ headers: { authorization: "Bearer nope" } }));

    expect(missing?.status).toBe(401);
    expect(wrong?.status).toBe(401);
  });

  test("accepts the key via authorization bearer or x-llm-api-key header", () => {
    const env = { BFF_LLM_API_KEY: "secret" } as NodeJS.ProcessEnv;
    const gate = createLlmGate({ env });

    const viaAuth = gate(llmRequest({ headers: { authorization: "Bearer secret" } }));
    const viaHeader = gate(llmRequest({ headers: { "x-llm-api-key": "secret" } }));

    expect(viaAuth).toBeNull();
    expect(viaHeader).toBeNull();
  });

  test("enforces a fixed-window quota per key", () => {
    const env = {
      BFF_LLM_API_KEY: "secret",
      BFF_LLM_QUOTA_MAX: "2",
      BFF_LLM_QUOTA_WINDOW_MS: "60000",
    } as NodeJS.ProcessEnv;
    let ts = 0;
    const gate = createLlmGate({ env, now: () => ts });

    expect(gate(llmRequest({ headers: { authorization: "Bearer secret" } }))).toBeNull();
    expect(gate(llmRequest({ headers: { authorization: "Bearer secret" } }))).toBeNull();
    const third = gate(llmRequest({ headers: { authorization: "Bearer secret" } }));
    expect(third?.status).toBe(429);

    // A new window resets the quota.
    ts += 60_001;
    expect(gate(llmRequest({ headers: { authorization: "Bearer secret" } }))).toBeNull();
  });

  test("applies the default quota when quota env is unset", () => {
    const env = { BFF_LLM_API_KEY: "secret" } as NodeJS.ProcessEnv;
    const gate = createLlmGate({ env, now: () => 0 });

    for (let i = 0; i < 30; i++) {
      expect(gate(llmRequest({ headers: { authorization: "Bearer secret" } }))).toBeNull();
    }
    expect(gate(llmRequest({ headers: { authorization: "Bearer secret" } }))?.status).toBe(429);
  });
});
