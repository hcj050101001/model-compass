import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StandardizedModelCostRecord } from "@/lib/agent-cost/types";
import type { MeasurementRow } from "@/lib/analytics/types";
import { calculateParetoFrontier } from "@/lib/analytics/pareto";
import {
  LEGACY_TEMPLATE_VERSION,
  MULTI_TURN_TEMPLATE_VERSION,
} from "@/lib/agent-cost/developer-cost";
import { getDeveloperAgentCost } from "@/lib/utils/format";

export function toStandardizedRecord(row: MeasurementRow): StandardizedModelCostRecord {
  return {
    model_id: row.variantId,
    model_name: row.displayName,
    provider: row.creatorSlug,
    reasoning_effort: row.effortNormalized ?? "Standard",
    intelligence_index: row.intelligenceScore,
    pricing: {
      input_per_million: row.inputPricePerMillion,
      output_per_million: row.outputPricePerMillion,
      cache_read_per_million: row.cacheReadPricePerMillion,
      cache_write_per_million: row.cacheWritePricePerMillion,
      currency: "USD",
    },
    agent_usage: row.agentUsage,
    agent_cost: row.agentCost,
    data_quality: row.dataQuality,
  };
}

/**
 * Package B export-summary check: recomputes a deterministic summary from
 * rows re-read from the database (frozen metadata), so a later dimension
 * rename can be proven not to change the exported summary. This does not
 * change the export file layout (byte-level immutability is Package E).
 */
export function computeStandardizedSummary(rows: MeasurementRow[]): string {
  const records = rows
    .map(toStandardizedRecord)
    .sort((a, b) => a.model_id.localeCompare(b.model_id));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(records))
    .digest("hex");
}

/** Runtime data root; the publication files and the DB share one volume. */
export function getDataDir(): string {
  const override = process.env.MODEL_COMPASS_DATA_DIR;
  return override && override.trim().length > 0
    ? path.resolve(override)
    : path.resolve(process.cwd(), "data");
}

export function sha256Hex(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export interface StandardizedExportPayload {
  schema_version: string;
  snapshot_id: string | null;
  generated_at: string;
  fetched_at: string | null;
  source_data_at: string | null;
  index_version: string;
  is_demo: boolean;
  model_count: number;
  pareto_frontiers: {
    real_rasc_model_ids: string[];
    estimated_eac_model_ids: string[];
  };
  cost_metadata: {
    snapshot_id: string | null;
    cost_mode: string;
    cost_unit: string;
    task_profile: string;
    template_version: string;
    legacy_template_version: string;
    candidate_scope: string;
  };
  models: StandardizedModelCostRecord[];
}

export function buildStandardizedExportPayload(params: {
  rows: MeasurementRow[];
  indexVersion: string;
  generatedAt: string;
  isDemo: boolean;
  snapshotId?: string | null;
  fetchedAt?: string | null;
  sourceDataAt?: string | null;
}): StandardizedExportPayload {
  const { rows, indexVersion, generatedAt, isDemo } = params;
  const records = rows.map(toStandardizedRecord);

  // Compute separate Pareto frontiers (strict isolation: never mix A/B with C)
  const realFrontier = calculateParetoFrontier(
    rows
      .filter(
        (r) =>
          (r.dataQuality.level === "A" || r.dataQuality.level === "B") &&
          r.agentCost.rasc !== null &&
          r.intelligenceScore !== null
      )
      .map((r) => ({
        id: r.variantId,
        cost: r.agentCost.rasc as number,
        score: r.intelligenceScore as number,
        indexVersion: r.indexVersion,
        qualityLevel: r.dataQuality.level,
      })),
    { indexVersion, allowedQualityLevels: ["A", "B"] }
  );

  // Estimated frontier on the unified cost basis (design sec.2.5): every
  // candidate is priced by the same standard-tier multi-turn simulation
  // (getDeveloperAgentCost) used by the chart, leaderboard, compare and
  // frontier API — never by a stored legacy amount. Candidates are the
  // full (all-vendor) scope of this snapshot; consumers comparing against
  // a vendor-scoped frontier must recompute under that same scope.
  // estimated_eac_model_ids therefore means: variant IDs on the standard,
  // positive-estimate, same-index-version, finite-score, all-vendor
  // Pareto frontier.
  const estimatedFrontier = calculateParetoFrontier(
    rows
      .map((r) => {
        if (r.intelligenceScore === null || !Number.isFinite(r.intelligenceScore)) {
          return null;
        }
        const dev = getDeveloperAgentCost(r, "standard");
        if (!dev || dev.totalUsd <= 0) return null;
        return {
          id: r.variantId,
          cost: dev.totalUsd,
          score: r.intelligenceScore,
          indexVersion: r.indexVersion,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null),
    { indexVersion }
  );

  const snapshotId = params.snapshotId ?? rows[0]?.snapshotId ?? null;
  return {
    schema_version: "2.0.0",
    snapshot_id: snapshotId,
    generated_at: generatedAt,
    fetched_at: params.fetchedAt ?? null,
    source_data_at: params.sourceDataAt ?? null,
    index_version: indexVersion,
    is_demo: isDemo,
    model_count: records.length,
    // Cost-basis metadata (design sec.2.5): simulated amounts in this
    // export are USD per simulated task at the standard task profile
    // under the multi-turn template version below; stored agent_cost
    // values without a snapshot template version are legacy fallbacks.
    cost_metadata: {
      snapshot_id: snapshotId,
      cost_mode: "eac",
      cost_unit: "USD/simulated task",
      task_profile: "standard",
      template_version: MULTI_TURN_TEMPLATE_VERSION,
      legacy_template_version: LEGACY_TEMPLATE_VERSION,
      candidate_scope: "all",
    },
    pareto_frontiers: {
      real_rasc_model_ids: Array.from(realFrontier.frontierIds),
      estimated_eac_model_ids: Array.from(estimatedFrontier.frontierIds),
    },
    models: records,
  };
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write bytes to `dir/fileName` atomically: exclusive temp file in the same
 * directory, fsync, rename over the target, fsync the directory. A crash at
 * any point leaves either the old complete file or the new complete file.
 */
export function writeFileAtomically(
  dir: string,
  fileName: string,
  bytes: string
): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, fileName);
  const tmp = path.join(
    dir,
    `.${fileName}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeFileSync(fd, bytes, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  fsyncDir(dir);
  return target;
}

/**
 * Write bytes to `dir/fileName` immutably: exclusive temp file in the same
 * directory, fsync, then hard-link the temp file onto the target. The link
 * is atomic and fails with EEXIST when the target already exists, so two
 * concurrent writers can never overwrite each other — exactly one wins and
 * the loser observes the winner's file. Returns false when the target
 * already existed (temp file removed, target untouched).
 */
function writeFileImmutableAtomically(
  dir: string,
  fileName: string,
  bytes: string
): boolean {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, fileName);
  const tmp = path.join(
    dir,
    `.${fileName}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeFileSync(fd, bytes, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  fs.rmSync(tmp, { force: true });
  fsyncDir(dir);
  return true;
}

export interface PublicationFile {
  /** Path relative to the data dir, registered in the DB publication record. */
  relativePath: string;
  absolutePath: string;
  sha256: string;
  serialized: string;
}

/**
 * Write the immutable per-snapshot publication file
 * (`snapshots/<snapshotId>.json`). If the file already exists it is reused
 * only when its bytes hash to the same SHA-256; a digest conflict fails
 * closed instead of overwriting a published version.
 */
export function writeImmutablePublicationFile(params: {
  snapshotId: string;
  payload: StandardizedExportPayload;
}): PublicationFile {
  const { snapshotId } = params;
  if (!/^[A-Za-z0-9_-]+$/.test(snapshotId)) {
    throw new Error(`Unsafe snapshot id for publication path: ${snapshotId}`);
  }
  const serialized = JSON.stringify(params.payload, null, 2);
  const sha256 = sha256Hex(serialized);
  const relativePath = `snapshots/${snapshotId}.json`;
  const absolutePath = path.join(getDataDir(), relativePath);

  // Atomic immutable publish: the hard-link create either wins outright or
  // reports the target already exists — there is no check-then-overwrite
  // window in which a concurrent writer could replace a published file.
  const created = writeFileImmutableAtomically(
    path.dirname(absolutePath),
    `${snapshotId}.json`,
    serialized
  );
  if (!created) {
    const existing = fs.readFileSync(absolutePath, "utf8");
    if (sha256Hex(existing) !== sha256) {
      throw new Error(
        `Publication file for snapshot ${snapshotId} already exists with a different digest; refusing to overwrite an immutable version.`
      );
    }
    return { relativePath, absolutePath, sha256, serialized: existing };
  }
  return { relativePath, absolutePath, sha256, serialized };
}

/** Read a registered publication file by its data-dir-relative path. */
export function readPublicationFile(relativePath: string): string | null {
  const dataDir = getDataDir();
  const absolute = path.resolve(dataDir, relativePath);
  if (!absolute.startsWith(dataDir + path.sep)) return null;
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

/**
 * Copy already-verified publication bytes to the fixed distribution paths
 * (`standardized-models.json` and `history/<UTC date>.json`) without
 * re-serialization. Idempotent: safe to re-run as a repair step.
 */
export function writeDistributionCopies(params: {
  serialized: string;
  dateTag: string;
}): { mainPath: string; historyPath: string } {
  const dataDir = getDataDir();
  const mainPath = writeFileAtomically(
    dataDir,
    "standardized-models.json",
    params.serialized
  );
  const historyPath = writeFileAtomically(
    path.join(dataDir, "history"),
    `${params.dateTag}.json`,
    params.serialized
  );
  return { mainPath, historyPath };
}

export function exportStandardizedSnapshotFiles(params: {
  rows: MeasurementRow[];
  indexVersion: string;
  generatedAt: string;
  isDemo: boolean;
}): { mainPath: string; historyPath: string } {
  const payload = buildStandardizedExportPayload(params);
  const serialized = JSON.stringify(payload, null, 2);
  return writeDistributionCopies({
    serialized,
    dateTag: params.generatedAt.slice(0, 10),
  });
}
