import { createBffHandler } from "./http";
import { createX402DiscoveryStore } from "./data/x402-discovery/store";
import { resolveDiscoverySigner } from "./data/x402-discovery/signing";

const port = Number(process.env.PORT ?? "3001");
const idleTimeout = Number(process.env.BFF_HTTP_IDLE_TIMEOUT_SECONDS ?? "60");

// Seed the x402 discovery store from committed slim snapshots at startup so the
// read endpoint serves data immediately (offline); the authorized refresh
// endpoint replaces it with live facilitator data on demand.
const x402Store = createX402DiscoveryStore();
const x402Status = x402Store.loadInitial();
console.log(
  `x402 discovery store: source=${x402Status.source} cdp=${x402Status.counts.cdp} dexter=${x402Status.counts.dexter} payai=${x402Status.counts.payai}`,
);

// Signs the discovery catalog served at /aeo/x402/snapshot (key published at
// /aeo/x402/signing-key). Set BFF_DISCOVERY_SIGNING_KEY in production.
const discoverySigner = resolveDiscoverySigner();
console.log(
  `x402 discovery signing key: keyId=${discoverySigner.keyId} ephemeral=${discoverySigner.ephemeral}`,
);

const handler = createBffHandler(undefined, undefined, undefined, x402Store, discoverySigner);

Bun.serve({
  port,
  idleTimeout,
  fetch: handler,
});

console.log(`Flovia BFF listening on http://localhost:${port}`);
