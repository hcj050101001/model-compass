import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StandardizedModelCostRecord } from "@/lib/agent-cost/types";
import type { MeasurementRow } from "@/lib/analytics/types";
import { calculateParetoFrontier } from "@/lib/analytics/pareto";

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

  const estimatedFrontier = calculateParetoFrontier(
    rows
      .filter(
        (r) =>
          r.agentCost.estimated_cost !== null &&
          r.intelligenceScore !== null &&
          r.dataQuality.level !== "D"
      )
      .map((r) => ({
        id: r.variantId,
        cost: r.agentCost.estimated_cost as number,
        score: r.intelligenceScore as number,
        indexVersion: r.indexVersion,
      })),
    { indexVersion }
  );

  return {
    schema_version: "2.0.0",
    snapshot_id: params.snapshotId ?? null,
    generated_at: generatedAt,
    fetched_at: params.fetchedAt ?? null,
    source_data_at: params.sourceDataAt ?? null,
    index_version: indexVersion,
    is_demo: isDemo,
    model_count: records.length,
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

  if (fs.existsSync(absolutePath)) {
    const existing = fs.readFileSync(absolutePath, "utf8");
    if (sha256Hex(existing) !== sha256) {
      throw new Error(
        `Publication file for snapshot ${snapshotId} already exists with a different digest; refusing to overwrite an immutable version.`
      );
    }
    return { relativePath, absolutePath, sha256, serialized: existing };
  }

  writeFileAtomically(path.dirname(absolutePath), `${snapshotId}.json`, serialized);
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
