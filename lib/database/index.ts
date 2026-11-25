import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

let clientInstance: Client | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;
let initialized = false;

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

export async function ensureSchema(): Promise<void> {
  if (initialized) return;
  const client = getClient();
  const statements = [
    `PRAGMA journal_mode = WAL;`,
    `PRAGMA foreign_keys = ON;`,
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

  for (const sql of statements) {
    await client.execute(sql);
  }

  // Migrate existing benchmark_measurements table safely without losing live data
  const tableInfo = await client.execute(`PRAGMA table_info(benchmark_measurements);`);
  const existingCols = new Set(
    tableInfo.rows.map((r) => String(r.name ?? ""))
  );
  const migrations: Array<[string, string]> = [
    ["agent_usage_json", "TEXT"],
    ["agent_cost_json", "TEXT"],
    ["data_quality_level", "TEXT NOT NULL DEFAULT 'D'"],
    ["data_source_type", "TEXT NOT NULL DEFAULT 'unavailable'"],
    ["data_sources_json", "TEXT"],
    ["data_updated_at", "TEXT"],
  ];
  for (const [col, def] of migrations) {
    if (!existingCols.has(col)) {
      await client.execute(
        `ALTER TABLE benchmark_measurements ADD COLUMN ${col} ${def};`
      );
    }
  }
  if (existingCols.has("cost_per_task_usd")) {
    await client.execute(
      `ALTER TABLE benchmark_measurements DROP COLUMN cost_per_task_usd;`
    );
  }
  if (existingCols.has("cost_type")) {
    await client.execute(
      `ALTER TABLE benchmark_measurements DROP COLUMN cost_type;`
    );
  }

  initialized = true;
}
