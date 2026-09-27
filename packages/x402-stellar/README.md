# @flovia/x402-stellar

> Middleware HTTP que implementa el protocolo **x402 sobre Stellar** para cobrar por endpoints en USDC nativo.

## Idea

Un endpoint protegido devuelve `402 Payment Required` con un challenge (destino, monto, memo). El cliente firma una transacción USDC en Stellar, la submitea, y reintenta el request con el header `X-PAYMENT: <tx_hash>`. El middleware verifica el pago en Horizon y sirve el recurso.

## Estructura

```
src/
├── types.ts        # esquemas Zod del protocolo
├── server.ts       # middleware estilo Hono/Express
├── client.ts       # helper para agentes (paga + reintenta)
├── verify.ts       # verificación on-chain (consulta Horizon)
├── replay-store.ts          # ReplayStore contract + in-memory store (tests/dev)
├── replay-store-postgres.ts # durable store: INSERT ... ON CONFLICT DO NOTHING
└── replay-store-redis.ts    # durable store: SET NX, no TTL
```

## Instalación (en el monorepo)

Por ahora vive dentro del repo como `@flovia/x402-stellar`. Para publicarlo a npm más adelante.

```ts
import { SQL } from "bun";
import { createPostgresReplayStore, x402Stellar } from "@flovia/x402-stellar";
import { Hono } from "hono";

const replayStore = createPostgresReplayStore({ sql: new SQL(process.env.X402_REPLAY_DATABASE_URL!) });
await replayStore.ensureSchema();

const app = new Hono();

app.use(
  "/api/*",
  x402Stellar({
    destination: process.env.PROVIDER_ACCOUNT!,      // G...
    amountUsdc: "0.005",
    network: "testnet",
    replayStore,
    onPaymentVerified: async ({ txHash, payer }) => {
      // opcional: log_payment al contrato Soroban
    },
  })
);

app.get("/api/rate", (c) => c.json({ pair: "EUR/USD", rate: 1.0843 }));

export default app;
```

## Replay protection

A tx hash that bought a resource once can never buy it again. `replayStore` is required and must be shared by every replica and survive restarts:

- `createPostgresReplayStore({ sql })` — recommended. The `tx_hash` primary key plus `INSERT ... ON CONFLICT DO NOTHING RETURNING` is an atomic set-if-absent. Call `ensureSchema()` at startup, or apply `postgresReplayStoreSchema()` in a migration.
- `createRedisReplayStore({ client })` — `SET key value NX` with no TTL. Only durable if Redis runs with AOF persistence and `maxmemory-policy noeviction`.
- `createMemoryReplayStore()` — tests and single-process local dev only.

Consumed hashes never expire. Hashes are normalized to lowercase hex, so case variants of one payment are the same payment.

Request flow: reject malformed hashes → skip known replays (`has`) → verify on Horizon → atomically `claim` the hash → await `settlePayment` if configured → serve. The hash is only claimed after verification succeeds, so a failed check does not burn a payment. If the store is unreachable, the middleware fails closed with `503 replay_store_unavailable`.

### Requiring the on-chain `TxConsumed` entry

To also require the Soroban registry's replay guard before serving, await the on-chain log in `settlePayment`. `log_payment` panics with `PaymentAlreadyLogged` for a hash already in `TxConsumed`, and the middleware then answers `402 settlement_failed`:

```ts
x402Stellar({
  // ...
  replayStore,
  settlePayment: (payment) => logPaymentOnChain(registryOpts, payment),
});
```

This adds a Soroban round-trip (several seconds) to each paid request. If settlement fails, the hash stays consumed rather than being released, because releasing it could reopen a replay.

## Cliente (agente)

```ts
import { x402Pay } from "@flovia/x402-stellar/client";

const data = await x402Pay({
  url: "https://provider.example/api/rate",
  agentSecret: process.env.AGENT_SECRET!,
  network: "testnet",
});
```

## Sponsored Stellar fees (Testnet-only, opt-in)

Agents normally need XLM to submit a USDC payment because Stellar transaction fees are paid in XLM. This package exposes a policy decision helper for a provider or HANDLE sponsor, but it intentionally does **not** submit or sign fee-bump transactions automatically.

The planned implementation is classic Stellar fee-bump: the agent signs the inner USDC payment transaction, and a sponsor signs the outer fee-bump transaction. Soroban authorization/SAC flows are a separate design and must not be mixed into the classic payment path. Sponsorship is disabled on Public by this package's policy until challenge binding and the operational review are complete.

Before adding a signer/submitter, the integration must:

- bind the inner payment to the exact issued 402 challenge (destination, USDC issuer, amount, memo, network, and expiry); this depends on issues #2–#4
- enforce an explicit sponsor account, daily USDC cap, provider allowlist, and kill-switch
- meter sponsored fee spend separately from collected protocol fees
- reject sponsorship when the agent does not have enough USDC, the challenge is expired, or the transaction contains extra/unapproved operations
- prove the Testnet scenario with an agent holding zero XLM, a sponsored USDC payment, and a delivered resource before any Public enablement
- threat-model the drain risk alongside issue #6

Use `decideSponsorship` as the deterministic policy layer; transaction construction, authorization, persistence, and metrics belong to the deployment-specific sponsor service.

## Decisiones clave

- **Sólo USDC.** Multi-asset queda para v2.
- **Memo único** por challenge: garantiza idempotencia.
- **Replay protection** durable (Postgres/Redis), atomic, never expires.
- **Verificación contra Horizon**, nunca contra el cliente.

## Tests

```bash
bun test
```
