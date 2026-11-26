import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { MAINSTREAM_PROVIDER_SET } from "@/lib/analytics/homepage-providers";
import { getCoverageThresholds } from "@/lib/sync/coverage";
import { getMaxSnapshotAgeMinutes } from "@/lib/ops/sync-config";
import { getDataDir } from "@/lib/sync/standardized-export";

/**
 * Readiness evaluation (Package F, design §2.7). Pure read path: it never
 * creates a database, runs DDL or writes publication files. The public
 * response exposes only a status and a reason code — no ids, digests,
 * paths, timestamps or underlying error text.
 *
 * Check order (first failure wins):
 *   schema_missing → storage_unavailable → no_active_snapshot →
 *   demo_snapshot → coverage_below_minimum → publication_unavailable →
 *   snapshot_unverified → snapshot_expired → ready
 */

export type ReadinessReason =
  | "ready"
  | "schema_missing"
  | "storage_unavailable"
  | "no_active_snapshot"
  | "demo_snapshot"
  | "coverage_below_minimum"
  | "coverage_config_unavailable"
  | "publication_unavailable"
  | "snapshot_unverified"
  | "snapshot_expired";

export interface ReadinessResult {
  ready: boolean;
  reason: ReadinessReason;
}

function resolveDbPath(): string | null {
  const raw = process.env.DATABASE_URL ?? "file:./data/frontier.db";
  if (!raw.startsWith("file:")) return null;
  const filePath = raw.slice("file:".length);
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

export async function evaluateReadiness(
  now: Date = new Date()
): Promise<ReadinessResult> {
  const dbPath = resolveDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { ready: false, reason: "schema_missing" };
  }

  let thresholds: ReturnType<typeof getCoverageThresholds>;
  try {
    thresholds = getCoverageThresholds();
  } catch {
    return { ready: false, reason: "coverage_config_unavailable" };
  }

  let client!: ReturnType<typeof createClient>;
  try {
    client = createClient({ url: `file:${dbPath}` });
    const tables = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('data_snapshots','benchmark_measurements','sync_jobs')`
    );
    if (tables.rows.length < 3) {
      client.close();
      return { ready: false, reason: "schema_missing" };
    }
    // Publication columns are part of the expected schema.
    const cols = await client.execute(`PRAGMA table_info(data_snapshots)`);
    const colNames = new Set(cols.rows.map((r) => String(r.name ?? "")));
    if (!colNames.has("published_at") || !colNames.has("export_path")) {
      client.close();
      return { ready: false, reason: "schema_missing" };
    }
  } catch {
    try {
      client.close();
    } catch {
      // Client creation itself failed; nothing to close.
    }
    return { ready: false, reason: "storage_unavailable" };
  }

  try {
    const activeRes = await client.execute(
      `SELECT id, is_demo, export_path, last_verified_fetch_at
       FROM data_snapshots WHERE status='active' ORDER BY fetched_at DESC LIMIT 1`
    );
    if (activeRes.rows.length === 0) {
      return { ready: false, reason: "no_active_snapshot" };
    }
    const snap = activeRes.rows[0];
    if (Number(snap.is_demo) === 1 || process.env.DEMO_MODE === "true") {
      return { ready: false, reason: "demo_snapshot" };
    }

    // Coverage counted like-for-like from the active snapshot's rows.
    const coverageRes = await client.execute({
      sql: `SELECT m.intelligence_score AS score, m.agent_cost_json AS cost_json, c.slug AS creator_slug
            FROM benchmark_measurements m
            JOIN model_variants v ON v.id = m.variant_id
            JOIN model_releases r ON r.id = v.model_release_id
            JOIN model_creators c ON c.id = r.creator_id
            WHERE m.snapshot_id = ?`,
      args: [String(snap.id)],
    });
    let scored = 0;
    let positiveEstimate = 0;
    for (const row of coverageRes.rows) {
      const score = row.score === null ? null : Number(row.score);
      if (typeof score !== "number" || !Number.isFinite(score)) continue;
      scored += 1;
      let estimated: number | null = null;
      try {
        const parsed = JSON.parse(String(row.cost_json ?? "null")) as {
          estimated_cost?: unknown;
        } | null;
        estimated =
          typeof parsed?.estimated_cost === "number"
            ? parsed.estimated_cost
            : null;
      } catch {
        estimated = null;
      }
      if (
        MAINSTREAM_PROVIDER_SET.has(String(row.creator_slug)) &&
        typeof estimated === "number" &&
        Number.isFinite(estimated) &&
        estimated > 0
      ) {
        positiveEstimate += 1;
      }
    }
    if (
      scored < thresholds.minScoredModels ||
      positiveEstimate < thresholds.minPositiveEstimateModels ||
      positiveEstimate < 1
    ) {
      return { ready: false, reason: "coverage_below_minimum" };
    }

    // The registered publication file must exist and be a readable file.
    const exportPath = snap.export_path ? String(snap.export_path) : null;
    if (!exportPath) {
      return { ready: false, reason: "publication_unavailable" };
    }
    const dataDir = getDataDir();
    const absolute = path.resolve(dataDir, exportPath);
    if (!absolute.startsWith(dataDir + path.sep)) {
      return { ready: false, reason: "publication_unavailable" };
    }
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) {
        return { ready: false, reason: "publication_unavailable" };
      }
      const fd = fs.openSync(absolute, "r");
      fs.closeSync(fd);
    } catch {
      return { ready: false, reason: "publication_unavailable" };
    }

    // Freshness is judged on the same snapshot's last successful
    // verification fetch — never on another snapshot's job.
    const verifiedRaw = snap.last_verified_fetch_at
      ? String(snap.last_verified_fetch_at)
      : null;
    const verifiedAt = verifiedRaw ? Date.parse(verifiedRaw) : Number.NaN;
    if (!Number.isFinite(verifiedAt) || verifiedAt > now.getTime()) {
      return { ready: false, reason: "snapshot_unverified" };
    }
    const ageMinutes = (now.getTime() - verifiedAt) / 60_000;
    if (ageMinutes > getMaxSnapshotAgeMinutes()) {
      return { ready: false, reason: "snapshot_expired" };
    }

    return { ready: true, reason: "ready" };
  } catch {
    return { ready: false, reason: "storage_unavailable" };
  } finally {
    client.close();
  }
}
