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

  const snapshotId = rows[0]?.snapshotId ?? null;
  const payload = {
    schema_version: "2.0.0",
    generated_at: generatedAt,
    snapshot_id: snapshotId,
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
