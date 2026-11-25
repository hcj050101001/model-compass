import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXPECTED_SCHEMA_VERSION,
  SchemaCompatibilityError,
  assertSchemaCompatible,
  getSchemaVersion,
  runMigrations,
} from "@/lib/database";
import { mapAAModelsToNormalized } from "@/lib/data-sources/artificial-analysis/mapper";
import type { AAModelItem } from "@/lib/data-sources/artificial-analysis/schema";

const execFileAsync = promisify(execFile);
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-migration-"));
  tmpDirs.push(dir);
  return dir;
}

function fileClient(dir: string, name = "test.db"): Client {
  return createClient({ url: `file:${path.join(dir, name)}` });
}

const LEGACY_DDL = `
CREATE TABLE model_creators (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  country TEXT, website TEXT, color TEXT NOT NULL
);
CREATE TABLE model_releases (
  id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES model_creators(id),
  family TEXT NOT NULL, name TEXT NOT NULL, version TEXT, release_date TEXT,
  context_window INTEGER, is_open_weights INTEGER, source_url TEXT
);
CREATE TABLE model_variants (
  id TEXT PRIMARY KEY, model_release_id TEXT NOT NULL REFERENCES model_releases(id),
  source_id TEXT NOT NULL, source_slug TEXT NOT NULL, raw_name TEXT NOT NULL,
  display_name TEXT NOT NULL, effort_raw TEXT, effort_normalized TEXT,
  effort_order INTEGER, effort_ladder_type TEXT NOT NULL DEFAULT 'single',
  is_reasoning_model INTEGER, is_grouped INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE data_snapshots (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, benchmark_version TEXT NOT NULL,
  fetched_at TEXT NOT NULL, model_count INTEGER NOT NULL,
  variant_count INTEGER NOT NULL, content_hash TEXT NOT NULL,
  status TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE benchmark_measurements (
  id TEXT PRIMARY KEY, variant_id TEXT NOT NULL REFERENCES model_variants(id),
  source TEXT NOT NULL, source_url TEXT NOT NULL, index_name TEXT NOT NULL,
  index_version TEXT NOT NULL, intelligence_score REAL, coding_score REAL,
  agentic_score REAL, input_price_per_million REAL, output_price_per_million REAL,
  cache_read_price_per_million REAL, cache_write_price_per_million REAL,
  output_tokens_per_second REAL, time_to_first_token REAL, time_per_task REAL,
  measured_at TEXT, fetched_at TEXT NOT NULL, pricing_source TEXT,
  agent_usage_json TEXT, agent_cost_json TEXT,
  data_quality_level TEXT NOT NULL DEFAULT 'D',
  data_source_type TEXT NOT NULL DEFAULT 'unavailable',
  data_sources_json TEXT, data_updated_at TEXT,
  cost_per_task_usd REAL, cost_type TEXT,
  snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id)
);
CREATE TABLE sync_jobs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
  status TEXT NOT NULL, fetched_count INTEGER NOT NULL DEFAULT 0,
  valid_count INTEGER NOT NULL DEFAULT 0, rejected_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT, rate_limit_remaining INTEGER, rate_limit_reset TEXT
);
CREATE TABLE sync_locks (
  lock_key TEXT PRIMARY KEY, locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, owner TEXT NOT NULL
);
INSERT INTO model_creators VALUES ('creator_acme', 'Acme', 'acme', NULL, NULL, '#112233');
INSERT INTO model_releases VALUES ('rel_1', 'creator_acme', 'Model', 'Model X', 'v1', '2026-01-01', 1000, NULL, NULL);
INSERT INTO model_variants VALUES ('var_1', 'rel_1', 'src1', 'model-x', 'Model X', 'Model X', NULL, NULL, NULL, 'single', NULL, 0);
INSERT INTO data_snapshots VALUES ('snap_1', 'artificial-analysis', '5', '2026-01-02T00:00:00Z', 1, 1, 'hash1', 'active', 0);
INSERT INTO benchmark_measurements (id, variant_id, source, source_url, index_name, index_version, input_price_per_million, fetched_at, snapshot_id)
  VALUES ('meas_1', 'var_1', 'artificial-analysis', 'https://example.com', 'AA Intelligence Index', '5', 3, '2026-01-02T00:00:00Z', 'snap_1');
`;

async function schemaDump(client: Client): Promise<string> {
  const res = await client.execute(
    `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;`
  );
  return res.rows.map((r) => `${r.type}|${r.name}|${r.sql}`).join("\n");
}

describe("Package B: versioned migration registry", () => {
  it("initializes an empty database, is idempotent, and enforces the single-active constraint", async () => {
    const client = fileClient(makeTmpDir());
    const first = await runMigrations(client);
    expect(first.applied).toEqual([1, 2, 3]);
    expect(first.version).toBe(EXPECTED_SCHEMA_VERSION);
    expect(await getSchemaVersion(client)).toBe(EXPECTED_SCHEMA_VERSION);

    const second = await runMigrations(client);
    expect(second.applied).toEqual([]);

    await client.execute(
      `INSERT INTO data_snapshots VALUES ('s1', 'src', '5', '2026-01-01T00:00:00Z', 0, 0, 'h1', 'active', 0);`
    );
    await expect(
      client.execute(
        `INSERT INTO data_snapshots VALUES ('s2', 'src', '5', '2026-01-01T00:00:00Z', 0, 0, 'h2', 'active', 0);`
      )
    ).rejects.toThrow();
    client.close();
  });

  it("migrates a legacy database with old cost columns, backfills frozen metadata and marks legacy rows", async () => {
    const client = fileClient(makeTmpDir());
    await client.executeMultiple(LEGACY_DDL);
    const res = await runMigrations(client);
    expect(res.applied).toEqual([1, 2, 3]);

    const cols = await client.execute(`PRAGMA table_info(benchmark_measurements);`);
    const colNames = cols.rows.map((r) => String(r.name));
    // Legacy cost columns are preserved, never dropped or fabricated.
    expect(colNames).toContain("cost_per_task_usd");
    expect(colNames).toContain("cost_type");
    expect(colNames).toContain("frozen_release_name");
    expect(colNames).toContain("field_sources_json");

    const row = await client.execute(
      `SELECT frozen_release_name, frozen_creator_slug, legacy_backfill, field_sources_json FROM benchmark_measurements WHERE id = 'meas_1';`
    );
    expect(row.rows[0].frozen_release_name).toBe("Model X");
    expect(row.rows[0].frozen_creator_slug).toBe("acme");
    expect(row.rows[0].legacy_backfill).toBe(1);
    // Historical value with no recorded origin: source "unknown".
    expect(String(row.rows[0].field_sources_json)).toContain('"source":"unknown"');
    client.close();
  });

  it("errors on a dual-active-snapshot fixture instead of silently repairing it, and rolls back", async () => {
    const client = fileClient(makeTmpDir());
    await client.executeMultiple(LEGACY_DDL);
    await client.execute(
      `INSERT INTO data_snapshots VALUES ('snap_2', 'artificial-analysis', '5', '2026-01-03T00:00:00Z', 1, 1, 'hash2', 'active', 0);`
    );
    await expect(runMigrations(client)).rejects.toThrow(/active snapshots/);
    // Whole-transaction rollback: no version recorded, no frozen column added.
    expect(await getSchemaVersion(client)).toBe(0);
    const cols = await client.execute(`PRAGMA table_info(benchmark_measurements);`);
    expect(cols.rows.map((r) => String(r.name))).not.toContain("frozen_release_name");
    client.close();
  });

  it("assertSchemaCompatible rejects an unmigrated database with the identifiable error type", async () => {
    const client = fileClient(makeTmpDir());
    await client.executeMultiple(LEGACY_DDL);
    await expect(assertSchemaCompatible(client)).rejects.toBeInstanceOf(
      SchemaCompatibilityError
    );
    await runMigrations(client);
    await expect(assertSchemaCompatible(client)).resolves.toBeUndefined();
    client.close();
  });

  it("two concurrent processes cannot mutate the schema of an unmigrated database", async () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "old.db");
    const setup = createClient({ url: `file:${dbPath}` });
    await setup.executeMultiple(LEGACY_DDL);
    const before = await schemaDump(setup);
    setup.close();

    const probe = path.resolve(process.cwd(), "tests/helpers/schema-probe.ts");
    const runProbe = () =>
      execFileAsync("npx", ["tsx", probe], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
        timeout: 60_000,
      });
    const [a, b] = await Promise.all([runProbe(), runProbe()]);
    expect(a.stdout.trim()).toBe("SchemaCompatibilityError");
    expect(b.stdout.trim()).toBe("SchemaCompatibilityError");

    const after = createClient({ url: `file:${dbPath}` });
    expect(await schemaDump(after)).toBe(before);
    after.close();
  }, 120_000);
});

describe("Package B: frozen snapshot reads (application level)", () => {
  const appDir = makeTmpDir();
  const appDbPath = path.join(appDir, "app.db");
  let queries: typeof import("@/lib/database/queries");
  let exported: typeof import("@/lib/sync/standardized-export");
  let engine: typeof import("@/lib/sync/engine");

  beforeAll(async () => {
    process.env.DATABASE_URL = `file:${appDbPath}`;
    const client = createClient({ url: `file:${appDbPath}` });
    await runMigrations(client);
    await client.executeMultiple(`
      INSERT INTO model_creators VALUES ('creator_acme', 'Acme', 'acme', NULL, NULL, '#112233');
      INSERT INTO model_releases VALUES
        ('rel_a', 'creator_acme', 'Model', 'Model X', '2026-01-01', '2026-01-01', 1000, NULL, NULL),
        ('rel_b', 'creator_acme', 'Model', 'Model X', '2026-06-01', '2026-06-01', 2000, NULL, NULL);
      INSERT INTO model_variants VALUES
        ('var_a_low', 'rel_a', 'a-low', 'model-x-low', 'Model X (Low)', 'Model X (Low)', 'Low', 'Low', 10, 'standard', 1, 0),
        ('var_a_high', 'rel_a', 'a-high', 'model-x-high', 'Model X (High)', 'Model X (High)', 'High', 'High', 20, 'standard', 1, 0),
        ('var_b_low', 'rel_b', 'b-low', 'model-x-low-v2', 'Model X (Low)', 'Model X (Low)', 'Low', 'Low', 10, 'standard', 1, 0),
        ('var_b_high', 'rel_b', 'b-high', 'model-x-high-v2', 'Model X (High)', 'Model X (High)', 'High', 'High', 20, 'standard', 1, 0);
      INSERT INTO data_snapshots VALUES
        ('snap_frozen', 'artificial-analysis', '5', '2026-07-01T00:00:00Z', 2, 4, 'hashf', 'active', 0),
        ('snap_staging', 'artificial-analysis', '5', '2026-07-01T00:00:00Z', 0, 0, 'hashs', 'staging', 0);
    `);
    const frozen: Array<[string, string, string, string, number]> = [
      ["meas_a_low", "var_a_low", "Model X", "2026-01-01", 1000],
      ["meas_a_high", "var_a_high", "Model X", "2026-01-01", 1000],
      ["meas_b_low", "var_b_low", "Model X", "2026-06-01", 2000],
      ["meas_b_high", "var_b_high", "Model X", "2026-06-01", 2000],
    ];
    for (const [id, variantId, relName, relDate, ctx] of frozen) {
      await client.execute({
        sql: `INSERT INTO benchmark_measurements
          (id, variant_id, source, source_url, index_name, index_version, intelligence_score,
           input_price_per_million, output_price_per_million, fetched_at, snapshot_id,
           frozen_creator_name, frozen_creator_slug, frozen_release_name, frozen_release_date,
           frozen_context_window, frozen_display_name, frozen_effort_normalized, legacy_backfill)
          VALUES (?, ?, 'artificial-analysis', 'https://example.com', 'AA Intelligence Index', '5', 50,
           3, 15, '2026-07-01T00:00:00Z', 'snap_frozen', 'Acme', 'acme', ?, ?, ?, 'Model X', 'Low', 0);`,
        args: [id, variantId, relName, relDate, ctx],
      });
    }
    client.close();
    queries = await import("@/lib/database/queries");
    exported = await import("@/lib/sync/standardized-export");
    engine = await import("@/lib/sync/engine");
  });

  afterAll(() => {
    delete process.env.DATABASE_URL;
  });

  it("keeps distinct release IDs per release date and frozen metadata/summary survive renames", async () => {
    const first = await queries.getActiveMeasurements("snap_frozen");
    expect(first.rows).toHaveLength(4);
    expect(new Set(first.rows.map((r) => r.releaseId))).toEqual(
      new Set(["rel_a", "rel_b"])
    );
    const summaryBefore = exported.computeStandardizedSummary(first.rows);

    const client = createClient({ url: `file:${appDbPath}` });
    await client.executeMultiple(`
      UPDATE model_creators SET name = 'Renamed Co' WHERE id = 'creator_acme';
      UPDATE model_releases SET name = 'Model X Renamed', context_window = 9999 WHERE id IN ('rel_a', 'rel_b');
      UPDATE model_variants SET display_name = 'Changed Name';
    `);
    client.close();

    const second = await queries.getActiveMeasurements("snap_frozen");
    expect(second.rows.every((r) => r.releaseName === "Model X")).toBe(true);
    expect(second.rows.every((r) => r.creatorName === "Acme")).toBe(true);
    expect(second.rows.map((r) => r.contextWindow).sort()).toEqual([1000, 1000, 2000, 2000]);
    // Export summary recomputed from DB re-read is unchanged.
    expect(exported.computeStandardizedSummary(second.rows)).toBe(summaryBefore);
    // The DB-only legacy marker never leaks into public row payloads.
    expect(JSON.stringify(second.rows)).not.toContain("legacy_backfill");
    expect(JSON.stringify(second.rows)).not.toContain("legacyBackfill");
  });

  it("named reads only serve active/archived snapshots and reconciliation exposes the marker", async () => {
    const staging = await queries.getActiveMeasurements("snap_staging");
    expect(staging.snapshot).toBeNull();
    expect(staging.rows).toEqual([]);

    const reconciliation = await queries.getSnapshotReconciliation("snap_frozen");
    expect(reconciliation).toHaveLength(4);
    expect(reconciliation.every((r) => r.legacyBackfill === false)).toBe(true);
  });

  it("commitSnapshotAtomically writes frozen columns and firstObservedAt continues across snapshots", async () => {
    const item: AAModelItem = {
      id: "commit-model-1",
      name: "Commit Model (Low)",
      slug: "commit-model-low",
      release_date: "2026-03-01",
      model_creator: { name: "CommitCo", slug: "commitco" },
      evaluations: { artificial_analysis_intelligence_index: 42 },
      pricing: { price_1m_input_tokens: 3, price_1m_output_tokens: 15 },
    };
    const bundle1 = mapAAModelsToNormalized({
      items: [item],
      indexVersion: "5",
      fetchedAt: "2026-07-02T00:00:00Z",
    });
    const extras1 = new Map([
      [
        bundle1.measurements[0].variantId,
        {
          agentUsageJson: "{}",
          agentCostJson: "{}",
          dataQualityLevel: "D",
          dataSourceType: "unavailable",
          dataSourcesJson: "[]",
          dataUpdatedAt: "2026-07-02T00:00:00Z",
          fieldSourcesJson: JSON.stringify(bundle1.measurements[0].fieldSources ?? {}),
        },
      ],
    ]);
    const first = await engine.commitSnapshotAtomically({
      bundle: bundle1,
      extras: extras1,
      source: "artificial-analysis",
      indexVersion: "5",
      fetchedAt: "2026-07-02T00:00:00Z",
      isDemo: false,
    });
    expect(first.status).toBe("success");
    const rec1 = await queries.getSnapshotReconciliation(first.snapshotId);
    expect(rec1).toHaveLength(1);
    expect(rec1[0].firstObservedAt).toBe("2026-07-02T00:00:00Z");
    expect(rec1[0].legacyBackfill).toBe(false);

    // Second sync at a later time with the identical quote: the frozen
    // first-observation time must be carried over, not re-dated.
    const changedItem: AAModelItem = {
      ...item,
      evaluations: { artificial_analysis_intelligence_index: 43 },
    };
    const bundle2 = mapAAModelsToNormalized({
      items: [changedItem],
      indexVersion: "5",
      fetchedAt: "2026-07-05T00:00:00Z",
    });
    const extras2 = new Map([
      [
        bundle2.measurements[0].variantId,
        {
          agentUsageJson: "{}",
          agentCostJson: "{}",
          dataQualityLevel: "D",
          dataSourceType: "unavailable",
          dataSourcesJson: "[]",
          dataUpdatedAt: "2026-07-05T00:00:00Z",
          fieldSourcesJson: JSON.stringify(bundle2.measurements[0].fieldSources ?? {}),
        },
      ],
    ]);
    const second = await engine.commitSnapshotAtomically({
      bundle: bundle2,
      extras: extras2,
      source: "artificial-analysis",
      indexVersion: "5",
      fetchedAt: "2026-07-05T00:00:00Z",
      isDemo: false,
    });
    expect(second.status).toBe("success");
    expect(second.snapshotId).not.toBe(first.snapshotId);
    const rec2 = await queries.getSnapshotReconciliation(second.snapshotId);
    expect(rec2[0].firstObservedAt).toBe("2026-07-02T00:00:00Z");
    const prov = rec2[0].fieldSources as Record<string, { firstObservedAt: string }>;
    expect(prov.input.firstObservedAt).toBe("2026-07-02T00:00:00Z");
  });
});

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
