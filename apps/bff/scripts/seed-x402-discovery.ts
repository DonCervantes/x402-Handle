#!/usr/bin/env bun
// Generate slim x402 discovery seed files for the BFF from full facilitator
// snapshots. The slim projection drops bulky Bazaar JSON schemas (kept only as a
// presence marker), shrinking ~100MB of raw registries to a few MB the BFF can
// bundle and hold in memory offline.
//
// Usage:
//   bun run scripts/seed-x402-discovery.ts [sourceDir] [outDir]
//   sourceDir default: repo-root discoveries/
//   outDir    default: apps/bff/data/x402-discovery/

import fs from "node:fs";
import path from "node:path";
import { slimX402DiscoveryItem, X402_FACILITATORS, type X402DiscoveryItem } from "sources";

const sourceDir = process.argv[2] ?? path.resolve(import.meta.dir, "../../../discoveries");
const outDir = process.argv[3] ?? path.resolve(import.meta.dir, "../data/x402-discovery");

fs.mkdirSync(outDir, { recursive: true });

// Newest raw snapshot mtime ~ when the registries were captured; recorded as
// the seed's provenance so signed discovery snapshots report its real age.
let capturedAtMs = 0;

for (const facilitator of X402_FACILITATORS) {
  const source = path.join(sourceDir, `${facilitator}.json`);
  if (!fs.existsSync(source)) {
    console.error(`skip ${facilitator}: ${source} not found`);
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(source, "utf8")) as X402DiscoveryItem[];
  const slim = raw.map(slimX402DiscoveryItem);
  capturedAtMs = Math.max(capturedAtMs, fs.statSync(source).mtimeMs);
  const out = path.join(outDir, `${facilitator}.json`);
  fs.writeFileSync(out, JSON.stringify(slim));
  console.error(`${facilitator}: ${raw.length} items -> ${out}`);
}

if (capturedAtMs > 0) {
  const meta = path.join(outDir, "meta.json");
  const generatedAt = new Date(capturedAtMs).toISOString();
  fs.writeFileSync(
    meta,
    `${JSON.stringify({ source: "seed", generatedAt, staleFacilitators: [] }, null, 2)}\n`,
  );
  console.error(`provenance: seed generatedAt=${generatedAt} -> ${meta}`);
}
