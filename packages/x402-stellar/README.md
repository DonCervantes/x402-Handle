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
└── replay-cache.ts # idempotencia por tx_hash
```

## Instalación (en el monorepo)

Por ahora vive dentro del repo como `@flovia/x402-stellar`. Para publicarlo a npm más adelante.

```ts
import { x402Stellar } from "@flovia/x402-stellar";
import { Hono } from "hono";

const app = new Hono();

app.use(
  "/api/*",
  x402Stellar({
    destination: process.env.PROVIDER_ACCOUNT!,      // G...
    amountUsdc: "0.005",
    network: "testnet",
    onPaymentVerified: async ({ txHash, payer }) => {
      // opcional: log_payment al contrato Soroban
    },
  })
);

app.get("/api/rate", (c) => c.json({ pair: "EUR/USD", rate: 1.0843 }));

export default app;
```

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
- **Replay protection** local con TTL de 24h por defecto.
- **Verificación contra Horizon**, nunca contra el cliente.

## Tests

```bash
bun test
```

## Soroban registry configuration

The indexer, BFF health endpoint, and demo-provider payment logger all use the
same `REGISTRY_CONTRACT_ID` environment variable. Set it to the deployed
Soroban registry contract ID for the selected network, and set
`SOROBAN_RPC_URL` to the matching RPC endpoint (for example,
`https://soroban-testnet.stellar.org` for Testnet). Services that read or write
registry state fail closed when the contract ID is missing; they never fall
back to a hard-coded contract.
