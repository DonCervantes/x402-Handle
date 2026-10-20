// In-memory x402 discovery store for the BFF.
//
// Startup loads from local files only (committed slim snapshots, or the data
// dir a prior refresh persisted to) — it never auto-fetches. The authorized
// refresh job fetches live, swaps the in-memory data, and persists it back to
// the data dir so the next process startup loads the refreshed data. Items are
// held in their slim projection so the full multi-facilitator registry fits
// comfortably in memory; aggregation per service happens on request.

import fs from "node:fs";
import path from "node:path";
import {
  type AeoDiscovery,
  type DiscoverySnapshotSource,
  DiscoverySnapshotSourceSchema,
} from "contracts";
import {
  type AeoAggregateOptions,
  type FetchX402DiscoveryOptions,
  type X402DiscoveryItem,
  type X402Facilitator,
  X402_FACILITATORS,
  aggregateAeoDiscovery,
  fetchX402Discovery,
  slimX402DiscoveryItem,
} from "sources";

export type X402DiscoverySource = "snapshot" | "live" | "empty";

export type X402DiscoveryStoreStatus = {
  source: X402DiscoverySource;
  fetchedAt: string;
  counts: Record<X402Facilitator, number>;
  lastRefreshAt?: string;
  lastRefreshErrors?: Partial<Record<X402Facilitator, string>>;
  /** When the last successful persist-to-disk completed. */
  lastPersistAt?: string;
  /** Message when the last persist attempt failed (data still served from memory). */
  persistError?: string;
};

/**
 * Provenance of the catalog currently in memory, as signed into discovery
 * snapshots: `seed` = the committed baseline, `live` = a facilitator refresh
 * (possibly loaded back from disk after a restart). `generatedAt` is when that
 * data was produced, not when this process loaded it.
 */
export type X402DiscoveryProvenance = {
  source: DiscoverySnapshotSource;
  generatedAt: string;
  staleFacilitators: X402Facilitator[];
};

export type X402DiscoverySnapshot = X402DiscoveryProvenance & {
  /** Increments every time the in-memory catalog is replaced. */
  revision: number;
  items: Record<X402Facilitator, X402DiscoveryItem[]>;
};

export type X402DiscoveryStore = {
  loadInitial(): X402DiscoveryStoreStatus;
  refresh(options?: FetchX402DiscoveryOptions): Promise<X402DiscoveryStoreStatus>;
  getAggregate(serviceHost: string, options?: AeoAggregateOptions): AeoDiscovery | null;
  status(): X402DiscoveryStoreStatus;
  /** Current catalog with its provenance; null when nothing is loaded. */
  snapshot(): X402DiscoverySnapshot | null;
};

// Provenance sidecar written next to the facilitator files. The committed seed
// ships one recording when it was captured.
export const X402_DISCOVERY_META_FILE = "meta.json";

// Used when no sidecar exists: an unknown age must never look fresh.
const UNKNOWN_GENERATED_AT = new Date(0).toISOString();

// apps/bff/data/x402-discovery (resolved relative to this module so it works in
// dev and in the Docker image, where apps/bff is copied wholesale).
export const DEFAULT_X402_DISCOVERY_DIR = path.resolve(
  import.meta.dir,
  "../../../data/x402-discovery",
);

const emptyItems = (): Record<X402Facilitator, X402DiscoveryItem[]> => ({
  cdp: [],
  dexter: [],
  payai: [],
});

// Read a facilitator's items from the first directory that has the file, so a
// persisted (refreshed) snapshot is preferred over the committed seed.
const readSnapshotFile = (dirs: string[], facilitator: X402Facilitator): X402DiscoveryItem[] => {
  for (const dir of dirs) {
    const file = path.join(dir, `${facilitator}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) return [];
      // Slim defensively in case a full (non-slim) snapshot is supplied.
      return parsed.map((item) => slimX402DiscoveryItem(item as X402DiscoveryItem));
    } catch (error) {
      console.error(`Failed to read x402 discovery snapshot ${file}`, error);
      return [];
    }
  }
  return [];
};

const readProvenance = (dirs: string[]): X402DiscoveryProvenance => {
  for (const dir of dirs) {
    const file = path.join(dir, X402_DISCOVERY_META_FILE);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const source = DiscoverySnapshotSourceSchema.safeParse(parsed.source);
      const generatedAt =
        typeof parsed.generatedAt === "string" && !Number.isNaN(Date.parse(parsed.generatedAt))
          ? new Date(parsed.generatedAt).toISOString()
          : UNKNOWN_GENERATED_AT;
      const stale = Array.isArray(parsed.staleFacilitators)
        ? X402_FACILITATORS.filter((f) => (parsed.staleFacilitators as unknown[]).includes(f))
        : [];
      return {
        source: source.success ? source.data : "seed",
        generatedAt,
        staleFacilitators: stale,
      };
    } catch (error) {
      console.error(`Failed to read x402 discovery provenance ${file}`, error);
      break;
    }
  }
  return { source: "seed", generatedAt: UNKNOWN_GENERATED_AT, staleFacilitators: [] };
};

export const createX402DiscoveryStore = (
  config: {
    dir?: string;
    dataDir?: string;
    /** Injectable for tests; defaults to the facilitator fetcher from `sources`. */
    fetchDiscovery?: typeof fetchX402Discovery;
  } = {},
): X402DiscoveryStore => {
  const fetchDiscovery = config.fetchDiscovery ?? fetchX402Discovery;
  // Committed read-only baseline (shipped in the image).
  const seedDir = config.dir ?? process.env.BFF_X402_DISCOVERY_DIR ?? DEFAULT_X402_DISCOVERY_DIR;
  // Writable location the refresh job persists to and startup prefers on load.
  // Defaults to the seed dir; point it at the mounted /data volume in production
  // (BFF_X402_DISCOVERY_DATA_DIR=/data/x402-discovery) to survive redeploys.
  const dataDir = config.dataDir ?? process.env.BFF_X402_DISCOVERY_DATA_DIR ?? seedDir;
  const readDirs = dataDir === seedDir ? [seedDir] : [dataDir, seedDir];

  let items = emptyItems();
  let source: X402DiscoverySource = "empty";
  let fetchedAt = new Date(0).toISOString();
  let lastRefreshAt: string | undefined;
  let lastRefreshErrors: Partial<Record<X402Facilitator, string>> | undefined;
  let lastPersistAt: string | undefined;
  let persistError: string | undefined;
  let provenance: X402DiscoveryProvenance | null = null;
  let revision = 0;

  const counts = (): Record<X402Facilitator, number> => ({
    cdp: items.cdp.length,
    dexter: items.dexter.length,
    payai: items.payai.length,
  });

  const status = (): X402DiscoveryStoreStatus => ({
    source,
    fetchedAt,
    counts: counts(),
    lastRefreshAt,
    lastRefreshErrors,
    lastPersistAt,
    persistError,
  });

  // Atomically write the current in-memory snapshot to the data dir (tmp file +
  // rename avoids a torn read if the process restarts mid-write) so the next
  // startup loads the refreshed data.
  const persist = (): void => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      for (const facilitator of X402_FACILITATORS) {
        const target = path.join(dataDir, `${facilitator}.json`);
        const tmp = `${target}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(items[facilitator]));
        fs.renameSync(tmp, target);
      }
      // Provenance last, so a crash mid-persist never labels old files as fresh.
      if (provenance) {
        const target = path.join(dataDir, X402_DISCOVERY_META_FILE);
        const tmp = `${target}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(provenance));
        fs.renameSync(tmp, target);
      }
      lastPersistAt = new Date().toISOString();
      persistError = undefined;
    } catch (error) {
      persistError = error instanceof Error ? error.message : String(error);
      console.error(`Failed to persist x402 discovery snapshot to ${dataDir}`, error);
    }
  };

  const loadInitial = (): X402DiscoveryStoreStatus => {
    const loaded = {
      cdp: readSnapshotFile(readDirs, "cdp"),
      dexter: readSnapshotFile(readDirs, "dexter"),
      payai: readSnapshotFile(readDirs, "payai"),
    };
    items = loaded;
    source =
      loaded.cdp.length + loaded.dexter.length + loaded.payai.length > 0 ? "snapshot" : "empty";
    fetchedAt = new Date().toISOString();
    provenance = source === "empty" ? null : readProvenance(readDirs);
    revision += 1;
    return status();
  };

  const refresh = async (
    options: FetchX402DiscoveryOptions = {},
  ): Promise<X402DiscoveryStoreStatus> => {
    const result = await fetchDiscovery({
      ...options,
      mapItem: options.mapItem ?? slimX402DiscoveryItem,
    });

    // Keep prior data for any facilitator that failed; swap the rest.
    const next = { ...items };
    for (const facilitator of X402_FACILITATORS) {
      if (result.errors[facilitator] === undefined) next[facilitator] = result[facilitator];
    }
    items = next;
    source = "live";
    fetchedAt = result.fetchedAt;
    lastRefreshAt = result.fetchedAt;
    lastRefreshErrors = Object.keys(result.errors).length > 0 ? result.errors : undefined;
    const staleFacilitators = X402_FACILITATORS.filter((f) => result.errors[f] !== undefined);
    // If every facilitator failed nothing was refreshed: keep the old provenance
    // rather than relabeling old data as a fresh live pull.
    if (staleFacilitators.length < X402_FACILITATORS.length) {
      provenance = {
        source: "live",
        generatedAt: new Date(result.fetchedAt).toISOString(),
        staleFacilitators,
      };
      revision += 1;
    }

    // Persist the refreshed snapshot locally so startup can load it next time.
    persist();
    return status();
  };

  const getAggregate = (
    serviceHost: string,
    options: AeoAggregateOptions = {},
  ): AeoDiscovery | null =>
    aggregateAeoDiscovery(items, serviceHost, {
      snapshotDate: options.snapshotDate ?? fetchedAt.slice(0, 10),
      description: options.description,
    });

  const snapshot = (): X402DiscoverySnapshot | null =>
    provenance ? { ...provenance, revision, items } : null;

  return { loadInitial, refresh, getAggregate, status, snapshot };
};
