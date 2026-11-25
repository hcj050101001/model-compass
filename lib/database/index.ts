import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

let clientInstance: Client | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

function resolveDbUrl(): string {
  const raw = process.env.DATABASE_URL ?? "file:./data/frontier.db";
  if (raw.startsWith("file:")) {
    const filePath = raw.slice("file:".length);
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return `file:${absPath}`;
  }
  return raw;
}

export function getClient(): Client {
  if (!clientInstance) {
    clientInstance = createClient({
      url: resolveDbUrl(),
    });
  }
  return clientInstance;
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle(getClient(), { schema });
  }
  return dbInstance;
}

/**
 * Thrown by read/request paths when the database schema version does not
 * match the version this code expects. Request paths must never mutate the
 * schema; they fail with this identifiable error instead (design sec.2.3).
 * HTTP layers map it to a desensitized 503.
 */
export class SchemaCompatibilityError extends Error {
  readonly code = "SCHEMA_INCOMPATIBLE";
  readonly expectedVersion: number;
  readonly actualVersion: number;
  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `Database schema version ${actualVersion} is not compatible with expected version ${expectedVersion}. Run "npm run db:migrate" first.`
    );
    this.name = "SchemaCompatibilityError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** Minimal executor surface shared by Client and write Transactions. */
interface SqlExecutor {
  execute(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const BASE_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS model_creators (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    country TEXT,
    website TEXT,
    color TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS model_releases (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES model_creators(id),
    family TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT,
    release_date TEXT,
    context_window INTEGER,
    is_open_weights INTEGER,
    source_url TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_releases_creator ON model_releases(creator_id);`,
  `CREATE TABLE IF NOT EXISTS model_variants (
    id TEXT PRIMARY KEY,
    model_release_id TEXT NOT NULL REFERENCES model_releases(id),
    source_id TEXT NOT NULL,
    source_slug TEXT NOT NULL,
    raw_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    effort_raw TEXT,
    effort_normalized TEXT,
    effort_order INTEGER,
    effort_ladder_type TEXT NOT NULL DEFAULT 'single',
    is_reasoning_model INTEGER,
    is_grouped INTEGER NOT NULL DEFAULT 0
  );`,
  `CREATE INDEX IF NOT EXISTS idx_variants_release ON model_variants(model_release_id);`,
  `CREATE INDEX IF NOT EXISTS idx_variants_slug ON model_variants(source_slug);`,
  `CREATE TABLE IF NOT EXISTS data_snapshots (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    benchmark_version TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    model_count INTEGER NOT NULL,
    variant_count INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0
  );`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_status ON data_snapshots(status);`,
  `CREATE TABLE IF NOT EXISTS benchmark_measurements (
    id TEXT PRIMARY KEY,
    variant_id TEXT NOT NULL REFERENCES model_variants(id),
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    index_name TEXT NOT NULL,
    index_version TEXT NOT NULL,
    intelligence_score REAL,
    coding_score REAL,
    agentic_score REAL,
    input_price_per_million REAL,
    output_price_per_million REAL,
    cache_read_price_per_million REAL,
    cache_write_price_per_million REAL,
    output_tokens_per_second REAL,
    time_to_first_token REAL,
    time_per_task REAL,
    measured_at TEXT,
    fetched_at TEXT NOT NULL,
    pricing_source TEXT,
    agent_usage_json TEXT,
    agent_cost_json TEXT,
    data_quality_level TEXT NOT NULL DEFAULT 'D',
    data_source_type TEXT NOT NULL DEFAULT 'unavailable',
    data_sources_json TEXT,
    data_updated_at TEXT,
    snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_measurements_snapshot ON benchmark_measurements(snapshot_id);`,
  `CREATE INDEX IF NOT EXISTS idx_measurements_variant ON benchmark_measurements(variant_id);`,
  `CREATE INDEX IF NOT EXISTS idx_measurements_version ON benchmark_measurements(index_version);`,
  `CREATE TABLE IF NOT EXISTS sync_jobs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    valid_count INTEGER NOT NULL DEFAULT 0,
    rejected_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    rate_limit_remaining INTEGER,
    rate_limit_reset TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS sync_locks (
    lock_key TEXT PRIMARY KEY,
    locked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    owner TEXT NOT NULL
  );`,
];

async function addColumnIfMissing(
  tx: SqlExecutor,
  table: string,
  column: string,
  definition: string
): Promise<void> {
  const info = await tx.execute(`PRAGMA table_info(${table});`);
  const existing = new Set(info.rows.map((r) => String(r.name ?? "")));
  if (!existing.has(column)) {
    await tx.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

/** Frozen-metadata / provenance columns added by migrations 2 (B) and 3 (C). */
const FROZEN_COLUMNS: Array<[string, string]> = [
  ["frozen_creator_name", "TEXT"],
  ["frozen_creator_slug", "TEXT"],
  ["frozen_release_name", "TEXT"],
  ["frozen_release_date", "TEXT"],
  ["frozen_context_window", "INTEGER"],
  ["frozen_display_name", "TEXT"],
  ["frozen_effort_normalized", "TEXT"],
  ["legacy_backfill", "INTEGER NOT NULL DEFAULT 0"],
];

const PROVENANCE_COLUMNS: Array<[string, string]> = [
  // JSON map: field -> { source, upstreamKey, currency, unit, observedAt, firstObservedAt }
  ["field_sources_json", "TEXT"],
  // JSON quality-evidence envelope (grading inputs, breakdown, eligibility)
  ["quality_evidence_json", "TEXT"],
  // Earliest first-observed timestamp across this row's priced fields
  ["first_observed_at", "TEXT"],
];

export interface MigrationDefinition {
  version: number;
  name: string;
  apply: (tx: SqlExecutor) => Promise<void>;
}

/**
 * Versioned migration registry (design sec.2.3 / ADR-4). Numbering is
 * sequential from 1 and append-only: later packages append new entries and
 * must never rewrite an already-published migration.
 *   1 = base schema (Package B; legacy cost columns are preserved, never dropped)
 *   2 = frozen release metadata + legacy backfill + single-active constraint (Package B)
 *   3 = per-field pricing provenance + quality evidence columns (Package C)
 *   4 = per-snapshot multi-turn template version (Package D)
 *   5 = publication record + sync-job provenance columns (Package E)
 */
export const MIGRATIONS: MigrationDefinition[] = [
  {
    version: 1,
    name: "base-schema",
    apply: async (tx) => {
      for (const sql of BASE_SCHEMA_STATEMENTS) {
        await tx.execute(sql);
      }
      // Legacy databases may already carry the agent-cost columns; make sure
      // they exist on fresh tables too. Legacy cost columns
      // (cost_per_task_usd / cost_type) are intentionally NOT dropped and no
      // historical values are fabricated for them (secretary ruling 3).
      for (const [col, def] of [
        ["agent_usage_json", "TEXT"],
        ["agent_cost_json", "TEXT"],
        ["data_quality_level", "TEXT NOT NULL DEFAULT 'D'"],
        ["data_source_type", "TEXT NOT NULL DEFAULT 'unavailable'"],
        ["data_sources_json", "TEXT"],
        ["data_updated_at", "TEXT"],
      ] as Array<[string, string]>) {
        await addColumnIfMissing(tx, "benchmark_measurements", col, def);
      }
    },
  },
  {
    version: 2,
    name: "frozen-release-metadata-and-single-active-snapshot",
    apply: async (tx) => {
      for (const [col, def] of FROZEN_COLUMNS) {
        await addColumnIfMissing(tx, "benchmark_measurements", col, def);
      }
      // A database with two or more active snapshots is corrupt: fail loudly
      // and require manual review instead of silently repairing it.
      const dup = await tx.execute(
        `SELECT COUNT(*) AS n FROM data_snapshots WHERE status = 'active';`
      );
      const activeCount = Number(dup.rows[0]?.n ?? 0);
      if (activeCount > 1) {
        throw new Error(
          `Migration aborted: database has ${activeCount} active snapshots; manual review required before a single-active constraint can be added.`
        );
      }
      await tx.execute(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_single_active ON data_snapshots(status) WHERE status = 'active';`
      );
      // One-time backfill of frozen metadata for pre-existing rows from the
      // current dimension tables; these rows are marked legacy_backfill so
      // named reconciliation reads can tell them apart (DB-only marker).
      await tx.execute(
        `UPDATE benchmark_measurements
           SET frozen_creator_name = (SELECT c.name FROM model_variants v JOIN model_releases r ON r.id = v.model_release_id JOIN model_creators c ON c.id = r.creator_id WHERE v.id = benchmark_measurements.variant_id),
               frozen_creator_slug = (SELECT c.slug FROM model_variants v JOIN model_releases r ON r.id = v.model_release_id JOIN model_creators c ON c.id = r.creator_id WHERE v.id = benchmark_measurements.variant_id),
               frozen_release_name = (SELECT r.name FROM model_variants v JOIN model_releases r ON r.id = v.model_release_id WHERE v.id = benchmark_measurements.variant_id),
               frozen_release_date = (SELECT r.release_date FROM model_variants v JOIN model_releases r ON r.id = v.model_release_id WHERE v.id = benchmark_measurements.variant_id),
               frozen_context_window = (SELECT r.context_window FROM model_variants v JOIN model_releases r ON r.id = v.model_release_id WHERE v.id = benchmark_measurements.variant_id),
               frozen_display_name = (SELECT v.display_name FROM model_variants v WHERE v.id = benchmark_measurements.variant_id),
               frozen_effort_normalized = (SELECT v.effort_normalized FROM model_variants v WHERE v.id = benchmark_measurements.variant_id),
               legacy_backfill = 1
         WHERE frozen_release_name IS NULL;`
      );
    },
  },
  {
    version: 3,
    name: "pricing-provenance-and-quality-evidence",
    apply: async (tx) => {
      for (const [col, def] of PROVENANCE_COLUMNS) {
        await addColumnIfMissing(tx, "benchmark_measurements", col, def);
      }
      // Historical rows have values but no recorded provenance: mark every
      // priced field as source "unknown" (strictly distinct from a missing
      // value, which stays null). No timestamps are fabricated.
      await tx.execute(
        `UPDATE benchmark_measurements
           SET field_sources_json = '{"input":{"source":"unknown","upstreamKey":null,"currency":null,"unit":null,"observedAt":null,"firstObservedAt":null},"output":{"source":"unknown","upstreamKey":null,"currency":null,"unit":null,"observedAt":null,"firstObservedAt":null},"cacheRead":{"source":"unknown","upstreamKey":null,"currency":null,"unit":null,"observedAt":null,"firstObservedAt":null},"cacheWrite":{"source":"unknown","upstreamKey":null,"currency":null,"unit":null,"observedAt":null,"firstObservedAt":null},"contextWindow":{"source":"unknown","upstreamKey":null,"currency":null,"unit":null,"observedAt":null,"firstObservedAt":null}}'
         WHERE field_sources_json IS NULL
           AND (input_price_per_million IS NOT NULL OR output_price_per_million IS NOT NULL
             OR cache_read_price_per_million IS NOT NULL OR cache_write_price_per_million IS NOT NULL);`
      );
    },
  },
  {
    version: 4,
    name: "snapshot-template-version",
    apply: async (tx) => {
      await addColumnIfMissing(tx, "data_snapshots", "template_version", "TEXT");
    },
  },
  {
    version: 5,
    name: "publication-record-and-sync-job-provenance",
    apply: async (tx) => {
      // Publication record columns on data_snapshots (Package E): set only
      // by the activation transaction / immutable publication path.
      for (const col of [
        "published_at",
        "file_generated_at",
        "source_data_at",
        "export_sha256",
        "export_path",
        "last_verified_fetch_at",
      ]) {
        await addColumnIfMissing(tx, "data_snapshots", col, "TEXT");
      }
      // Structured provenance columns on sync_jobs (Package E).
      for (const col of ["reason_code", "owner", "snapshot_id"]) {
        await addColumnIfMissing(tx, "sync_jobs", col, "TEXT");
      }
    },
  },
];

export const EXPECTED_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0
);

/** Highest migration number currently used (T2 report anchor for C/E appends). */
export const MAX_MIGRATION_VERSION = EXPECTED_SCHEMA_VERSION;

export async function getSchemaVersion(client?: Client): Promise<number> {
  const c = client ?? getClient();
  try {
    const res = await c.execute(
      `SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations;`
    );
    return Number(res.rows[0]?.v ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Applies every pending migration inside ONE SQLite write transaction:
 * re-check the recorded version, apply migrations in order, record each new
 * version. Any failure rolls the whole transaction back (DDL included), so a
 * failed migration leaves the previous schema untouched. Re-running when the
 * database is current is a no-op (idempotent).
 */
export async function runMigrations(client?: Client): Promise<{ applied: number[]; version: number }> {
  const c = client ?? getClient();
  const tx = await c.transaction("write");
  try {
    await tx.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );`
    );
    const currentRes = await tx.execute(
      `SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations;`
    );
    const current = Number(currentRes.rows[0]?.v ?? 0);
    const applied: number[] = [];
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      await migration.apply(tx as unknown as SqlExecutor);
      await tx.execute(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${migration.name}', '${new Date().toISOString()}');`
      );
      applied.push(migration.version);
    }
    await tx.commit();
    return { applied, version: Math.max(current, ...applied, current) };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // Transaction already closed; preserve the original error.
    }
    throw err;
  }
}

/**
 * Read-only compatibility check used by request/sync paths. Executes only a
 * SELECT against the migration registry; it never runs DDL or writes.
 */
export async function assertSchemaCompatible(client?: Client): Promise<void> {
  const actual = await getSchemaVersion(client);
  if (actual !== EXPECTED_SCHEMA_VERSION) {
    throw new SchemaCompatibilityError(EXPECTED_SCHEMA_VERSION, actual);
  }
}

/**
 * @deprecated Request paths must use assertSchemaCompatible(). This alias is
 * kept only so the explicit `db:migrate` entry point and legacy scripts keep
 * working; it runs the versioned migration registry.
 */
export async function ensureSchema(): Promise<void> {
  await runMigrations();
}
