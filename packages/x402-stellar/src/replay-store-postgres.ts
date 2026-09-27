// Postgres-backed ReplayStore. The PRIMARY KEY on tx_hash plus
// `ON CONFLICT DO NOTHING RETURNING` gives an atomic set-if-absent: exactly
// one INSERT per hash returns a row. Rows are never deleted.

import { type ReplayStore, requireTxHash } from "./replay-store";

/** Structural subset of `Bun.sql` / `new SQL(url)` used by this adapter. */
export interface PostgresReplaySql {
  unsafe(query: string, params?: unknown[]): PromiseLike<readonly unknown[]>;
}

export interface PostgresReplayStoreOpts {
  sql: PostgresReplaySql;
  /** Optionally schema-qualified table name. Default: x402_consumed_payments. */
  table?: string;
}

export interface PostgresReplayStore extends ReplayStore {
  /** Idempotently creates the backing table. Run once at startup or in a migration. */
  ensureSchema(): Promise<void>;
}

const DEFAULT_TABLE = "x402_consumed_payments";
const TABLE_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

export function postgresReplayStoreSchema(table = DEFAULT_TABLE): string {
  return `CREATE TABLE IF NOT EXISTS ${assertTable(table)} (
  tx_hash TEXT PRIMARY KEY CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
}

export function createPostgresReplayStore(opts: PostgresReplayStoreOpts): PostgresReplayStore {
  const table = assertTable(opts.table ?? DEFAULT_TABLE);
  const { sql } = opts;

  return {
    async ensureSchema() {
      await sql.unsafe(postgresReplayStoreSchema(table));
    },
    async has(txHash) {
      const rows = await sql.unsafe(`SELECT tx_hash FROM ${table} WHERE tx_hash = $1`, [
        requireTxHash(txHash),
      ]);
      return rows.length > 0;
    },
    async claim(txHash) {
      const rows = await sql.unsafe(
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
