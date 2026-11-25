import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { MAINSTREAM_PROVIDER_SET } from "../lib/analytics/homepage-providers";
import { getCoverageThresholds } from "../lib/sync/coverage";
import { readPublicationFile, sha256Hex } from "../lib/sync/standardized-export";

/**
 * Snapshot validation entry (Package E): verifies the active publication
 * against its DB publication record — non-demo marker, coverage, source,
 * four-time semantics and the registered file's SHA-256 — without writing
 * anything. Used by `npm run snapshot:verify`, CI (before any write
 * permission) and readiness drills. Prints a redacted JSON summary only
 * (ids, counts, digests, reason codes — never keys or payloads).
 *
 * Exit 0 = valid; exit 1 = invalid with `reasons` listing reason codes.
 * `--allow-demo` skips the demo rejection (local demo checks only).
 */

interface SnapshotRow {
  id: string;
  source: string;
  benchmark_version: string;
  fetched_at: string;
  status: string;
  is_demo: number;
  published_at: string | null;
  file_generated_at: string | null;
  source_data_at: string | null;
  export_sha256: string | null;
  export_path: string | null;
  last_verified_fetch_at: string | null;
  content_hash: string;
}

function resolveDbPath(): string | null {
  const raw = process.env.DATABASE_URL ?? "file:./data/frontier.db";
  if (!raw.startsWith("file:")) return null;
  const filePath = raw.slice("file:".length);
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

function parseableTime(value: string | null): boolean {
  return value !== null && Number.isFinite(Date.parse(value));
}

async function main(): Promise<void> {
  const allowDemo = process.argv.includes("--allow-demo");
  const reasons: string[] = [];
  const summary: Record<string, unknown> = { valid: false };

  const dbPath = resolveDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    reasons.push("no_database");
    console.log(JSON.stringify({ ...summary, reasons }, null, 2));
    process.exit(1);
  }

  const client = createClient({ url: `file:${dbPath}` });
  const tables = await client.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='data_snapshots'`
  );
  if (tables.rows.length === 0) {
    reasons.push("schema_missing");
    console.log(JSON.stringify({ ...summary, reasons }, null, 2));
    process.exit(1);
  }

  const activeRes = await client.execute(
    `SELECT * FROM data_snapshots WHERE status='active' ORDER BY fetched_at DESC`
  );
  if (activeRes.rows.length === 0) {
    reasons.push("no_active_snapshot");
    console.log(JSON.stringify({ ...summary, reasons }, null, 2));
    process.exit(1);
  }
  if (activeRes.rows.length > 1) {
    reasons.push("multiple_active_snapshots");
  }
  const snap = activeRes.rows[0] as unknown as SnapshotRow;
  summary.snapshot_id = snap.id;
  summary.index_version = snap.benchmark_version;
  summary.source = snap.source;
  summary.is_demo = snap.is_demo === 1;

  if (snap.is_demo === 1 && !allowDemo) reasons.push("demo_snapshot");
  if (snap.source !== "artificial-analysis" && snap.is_demo !== 1) {
    reasons.push("unexpected_source");
  }

  // Four-time semantics: fetched_at and published_at and file_generated_at
  // must be distinguishable, parseable times; source_data_at is null when
  // the upstream has no trustworthy timestamp.
  summary.fetched_at = snap.fetched_at;
  summary.published_at = snap.published_at;
  summary.file_generated_at = snap.file_generated_at;
  summary.source_data_at = snap.source_data_at;
  summary.last_verified_fetch_at = snap.last_verified_fetch_at;
  if (!parseableTime(snap.fetched_at)) reasons.push("invalid_fetched_at");
  if (!parseableTime(snap.published_at)) reasons.push("missing_published_at");
  if (!parseableTime(snap.file_generated_at)) {
    reasons.push("missing_file_generated_at");
  }
  if (snap.source_data_at !== null && !parseableTime(snap.source_data_at)) {
    reasons.push("invalid_source_data_at");
  }
  if (!parseableTime(snap.last_verified_fetch_at)) {
    reasons.push("snapshot_unverified");
  }

  // Coverage, counted like-for-like from the frozen measurement rows.
  const coverageRes = await client.execute({
    sql: `SELECT m.intelligence_score AS score, m.agent_cost_json AS cost_json, c.slug AS creator_slug
          FROM benchmark_measurements m
          JOIN model_variants v ON v.id = m.variant_id
          JOIN model_releases r ON r.id = v.model_release_id
          JOIN model_creators c ON c.id = r.creator_id
          WHERE m.snapshot_id = ?`,
    args: [snap.id],
  });
  let scored = 0;
  let positiveEstimate = 0;
  for (const row of coverageRes.rows) {
    const score = row.score === null ? null : Number(row.score);
    if (typeof score === "number" && Number.isFinite(score)) {
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
  }
  const thresholds = getCoverageThresholds();
  summary.coverage = {
    scored_models: scored,
    positive_estimate_models: positiveEstimate,
    min_scored_models: thresholds.minScoredModels,
    min_positive_estimate_models: thresholds.minPositiveEstimateModels,
    thresholds_provisional: thresholds.provisional,
  };
  if (coverageRes.rows.length === 0) reasons.push("empty_snapshot");
  if (scored < thresholds.minScoredModels) {
    reasons.push("coverage_below_minimum");
  }
  if (positiveEstimate < thresholds.minPositiveEstimateModels) {
    reasons.push("coverage_below_minimum");
  }
  if (positiveEstimate < 1) reasons.push("no_qualifying_homepage_candidate");

  // Publication file: registered relative path + SHA-256 must match the
  // bytes on disk, and the file must belong to this snapshot id.
  summary.export_path = snap.export_path;
  summary.export_sha256 = snap.export_sha256;
  if (!snap.export_path || !snap.export_sha256) {
    reasons.push("missing_publication_record");
  } else {
    const bytes = readPublicationFile(snap.export_path);
    if (bytes === null) {
      reasons.push("publication_file_missing");
    } else {
      const digest = sha256Hex(bytes);
      summary.file_sha256 = digest;
      if (digest !== snap.export_sha256) {
        reasons.push("publication_digest_mismatch");
      }
      try {
        const payload = JSON.parse(bytes) as {
          snapshot_id?: unknown;
          generated_at?: unknown;
          is_demo?: unknown;
        };
        if (payload.snapshot_id !== snap.id) {
          reasons.push("publication_snapshot_mismatch");
        }
        if (payload.generated_at !== snap.file_generated_at) {
          reasons.push("publication_generated_at_mismatch");
        }
        if (payload.is_demo !== (snap.is_demo === 1)) {
          reasons.push("publication_demo_marker_mismatch");
        }
      } catch {
        reasons.push("publication_file_unparseable");
      }
    }
  }

  summary.valid = reasons.length === 0;
  summary.reasons = reasons;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(reasons.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(
    "[snapshot:verify] Validation error:",
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
