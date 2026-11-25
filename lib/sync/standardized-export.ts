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

export function exportStandardizedSnapshotFiles(params: {
  rows: MeasurementRow[];
  indexVersion: string;
  generatedAt: string;
  isDemo: boolean;
}): { mainPath: string; historyPath: string } {
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

  const payload = {
    schema_version: "2.0.0",
    generated_at: generatedAt,
    index_version: indexVersion,
    is_demo: isDemo,
    model_count: records.length,
    pareto_frontiers: {
      real_rasc_model_ids: Array.from(realFrontier.frontierIds),
      estimated_eac_model_ids: Array.from(estimatedFrontier.frontierIds),
    },
    models: records,
  };

  const dataDir = path.resolve(process.cwd(), "data");
  const historyDir = path.join(dataDir, "history");
  fs.mkdirSync(historyDir, { recursive: true });

  const mainPath = path.join(dataDir, "standardized-models.json");
  const dateTag = generatedAt.slice(0, 10);
  const historyPath = path.join(historyDir, `${dateTag}.json`);

  const serialized = JSON.stringify(payload, null, 2);
  fs.writeFileSync(mainPath, serialized, "utf8");
  fs.writeFileSync(historyPath, serialized, "utf8");

  return { mainPath, historyPath };
}
