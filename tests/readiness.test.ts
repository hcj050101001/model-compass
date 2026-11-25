import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ready-"));
const dataDir = path.join(tmpRoot, "data");
fs.mkdirSync(path.join(dataDir, "snapshots"), { recursive: true });
const dbPath = path.join(tmpRoot, "frontier.db");

process.env.DATABASE_URL = `file:${dbPath}`;
process.env.MODEL_COMPASS_DATA_DIR = dataDir;
delete process.env.DEMO_MODE;
delete process.env.AA_API_KEY;
// Demo-sized fixtures cannot meet production coverage thresholds; the
// readiness scenarios below exercise the state machine, with coverage
// thresholds pinned to the fixture size via the documented env override.
process.env.MIN_SCORED_MODELS = "2";
process.env.MIN_POSITIVE_ESTIMATE_MODELS = "1";

let readiness: typeof import("@/lib/ops/readiness");
let dbModule: typeof import("@/lib/database");
let schema: typeof import("@/lib/database/schema");
let exported: typeof import("@/lib/sync/standardized-export");

// Fixed reference instant for the evaluation calls; the route handlers
// use the real clock, which stays within the same freshness windows.
const NOW = new Date();

async function resetDb(): Promise<void> {
  const db = dbModule.getDb();
  await db.delete(schema.benchmarkMeasurements);
  await db.delete(schema.dataSnapshots);
  await db.delete(schema.syncJobs);
  await db.delete(schema.modelVariants);
  await db.delete(schema.modelReleases);
  await db.delete(schema.modelCreators);
}

async function seedPublishedSnapshot(opts: {
  id: string;
  isDemo?: boolean;
  verifiedMinutesAgo?: number | null;
  withFile?: boolean;
  scoredRows?: number;
}): Promise<void> {
  const db = dbModule.getDb();
  const fetchedAt = new Date(NOW.getTime() - 10 * 60_000).toISOString();
  const verified =
    opts.verifiedMinutesAgo === null || opts.verifiedMinutesAgo === undefined
      ? null
      : new Date(NOW.getTime() - opts.verifiedMinutesAgo * 60_000).toISOString();

  await db.insert(schema.modelCreators).values({
    id: "creator_openai",
    name: "OpenAI",
    slug: "openai",
    country: null,
    website: null,
    color: "#000000",
  });
  await db.insert(schema.modelReleases).values({
    id: "release_1",
    creatorId: "creator_openai",
    family: "GPT",
    name: "GPT-Test",
    version: "1",
    releaseDate: "2026-01-01",
    contextWindow: 128000,
    isOpenWeights: false,
    sourceUrl: "https://example.invalid",
  });

  const payload = exported.buildStandardizedExportPayload({
    rows: [],
    indexVersion: "5",
    generatedAt: fetchedAt,
    isDemo: opts.isDemo ?? false,
    snapshotId: opts.id,
    fetchedAt,
    sourceDataAt: null,
  });
  let exportPath: string | null = null;
  let exportSha: string | null = null;
  if (opts.withFile !== false) {
    const pub = exported.writeImmutablePublicationFile({
      snapshotId: opts.id,
      payload,
    });
    exportPath = pub.relativePath;
    exportSha = pub.sha256;
  }

  await db.insert(schema.dataSnapshots).values({
    id: opts.id,
    source: "artificial-analysis",
    benchmarkVersion: "5",
    fetchedAt,
    modelCount: 1,
    variantCount: opts.scoredRows ?? 2,
    contentHash: `hash_${opts.id}`,
    status: "active",
    isDemo: opts.isDemo ?? false,
    publishedAt: fetchedAt,
    fileGeneratedAt: fetchedAt,
    sourceDataAt: null,
    exportSha256: exportSha,
    exportPath,
    lastVerifiedFetchAt: verified,
  });

  const rows = opts.scoredRows ?? 2;
  for (let i = 0; i < rows; i += 1) {
    const variantId = `var_${opts.id}_${i}`;
    await db.insert(schema.modelVariants).values({
      id: variantId,
      modelReleaseId: "release_1",
      sourceId: `src_${i}`,
      sourceSlug: `gpt-test-${i}`,
      rawName: `GPT-Test ${i}`,
      displayName: `GPT-Test ${i}`,
      effortRaw: null,
      effortNormalized: "Standard",
      effortOrder: 0,
      effortLadderType: "single",
      isReasoningModel: false,
      isGrouped: false,
    });
    await db.insert(schema.benchmarkMeasurements).values({
      id: `meas_${opts.id}_${i}`,
      variantId,
      source: "artificial-analysis",
      sourceUrl: "https://example.invalid",
      indexName: "Intelligence Index",
      indexVersion: "5",
      intelligenceScore: 50 + i,
      codingScore: null,
      agenticScore: null,
      inputPricePerMillion: 1,
      outputPricePerMillion: 2,
      cacheReadPricePerMillion: null,
      cacheWritePricePerMillion: null,
      outputTokensPerSecond: null,
      timeToFirstToken: null,
      timePerTask: null,
      measuredAt: null,
      fetchedAt,
      pricingSource: "artificial-analysis",
      agentCostJson: JSON.stringify({ estimated_cost: 1.5 }),
      snapshotId: opts.id,
    });
  }
}

beforeAll(async () => {
  readiness = await import("@/lib/ops/readiness");
  dbModule = await import("@/lib/database");
  schema = await import("@/lib/database/schema");
  exported = await import("@/lib/sync/standardized-export");
  await dbModule.ensureSchema();
}, 60_000);

describe("readiness evaluation", () => {
  it("empty volume: schema present but no active snapshot → 503 no_active_snapshot; health stays liveness-only", async () => {
    await resetDb();
    const result = await readiness.evaluateReadiness(NOW);
    expect(result).toEqual({ ready: false, reason: "no_active_snapshot" });

    const health = await import("@/app/api/health/route");
    const res = await health.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("missing database file → schema_missing without creating a DB", async () => {
    const ghost = path.join(tmpRoot, "ghost.db");
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${ghost}`;
    try {
      const result = await readiness.evaluateReadiness(NOW);
      expect(result.reason).toBe("schema_missing");
      expect(fs.existsSync(ghost)).toBe(false);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  it("verified fresh publication → ready", async () => {
    await resetDb();
    await seedPublishedSnapshot({ id: "snap_ready", verifiedMinutesAgo: 30 });
    const result = await readiness.evaluateReadiness(NOW);
    expect(result).toEqual({ ready: true, reason: "ready" });

    const readyRoute = await import("@/app/api/ready/route");
    const res = await readyRoute.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });

  it("demo snapshot → demo_snapshot", async () => {
    await resetDb();
    await seedPublishedSnapshot({
      id: "snap_demo",
      isDemo: true,
      verifiedMinutesAgo: 30,
    });
    expect((await readiness.evaluateReadiness(NOW)).reason).toBe(
      "demo_snapshot"
    );
  });

  it("stale verification time → snapshot_expired; exactly at the limit stays ready", async () => {
    await resetDb();
    await seedPublishedSnapshot({
      id: "snap_stale",
      verifiedMinutesAgo: 1441,
    });
    expect((await readiness.evaluateReadiness(NOW)).reason).toBe(
      "snapshot_expired"
    );

    await resetDb();
    await seedPublishedSnapshot({
      id: "snap_edge",
      verifiedMinutesAgo: 1440,
    });
    expect((await readiness.evaluateReadiness(NOW)).ready).toBe(true);
  });

  it("missing published file → publication_unavailable", async () => {
    await resetDb();
    await seedPublishedSnapshot({
      id: "snap_nofile",
      verifiedMinutesAgo: 30,
      withFile: false,
    });
    expect((await readiness.evaluateReadiness(NOW)).reason).toBe(
      "publication_unavailable"
    );
  });

  it("unverified snapshot (no successful verification fetch) → snapshot_unverified", async () => {
    await resetDb();
    await seedPublishedSnapshot({
      id: "snap_unverified",
      verifiedMinutesAgo: null,
    });
    expect((await readiness.evaluateReadiness(NOW)).reason).toBe(
      "snapshot_unverified"
    );
  });

  it("low coverage → coverage_below_minimum", async () => {
    await resetDb();
    await seedPublishedSnapshot({
      id: "snap_thin",
      verifiedMinutesAgo: 30,
      scoredRows: 1,
    });
    expect((await readiness.evaluateReadiness(NOW)).reason).toBe(
      "coverage_below_minimum"
    );
  });

  it("ready route returns 503 with only status/reason keys when not ready", async () => {
    await resetDb();
    const readyRoute = await import("@/app/api/ready/route");
    const res = await readyRoute.GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["reason", "status"]);
    expect(body.status).toBe("not_ready");
  });
});
