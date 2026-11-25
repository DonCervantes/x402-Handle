import { requireTxHash, type ReplayStore } from "./replay-store";

export interface PostgresReplaySql {
  unsafe(query: string, params?: unknown[]): PromiseLike<readonly unknown[]>;
}

export interface PostgresReplayStoreOpts {
  sql: PostgresReplaySql;
  table?: string;
}

export interface PostgresReplayStore extends ReplayStore {
  ensureSchema(): Promise<void>;
}

const DEFAULT_TABLE = "x402_consumed_payments";
const TABLE_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

export function postgresReplayStoreSchema(table = DEFAULT_TABLE): string {
  const safeTable = assertTable(table);
  return `CREATE TABLE IF NOT EXISTS ${safeTable} (
  tx_hash TEXT PRIMARY KEY CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
}

export function createPostgresReplayStore(opts: PostgresReplayStoreOpts): PostgresReplayStore {
  const table = assertTable(opts.table ?? DEFAULT_TABLE);

  return {
    async ensureSchema() {
      await opts.sql.unsafe(postgresReplayStoreSchema(table));
    },
    async claim(txHash) {
      const rows = await opts.sql.unsafe(
        `INSERT INTO ${table} (tx_hash) VALUES ($1) ON CONFLICT (tx_hash) DO NOTHING RETURNING tx_hash`,
        [requireTxHash(txHash)],
      );
      return rows.length === 1;
    },
  };
}

function assertTable(table: string): string {
  if (!TABLE_RE.test(table)) throw new Error(`invalid table name: ${JSON.stringify(table)}`);
  return table;
}
