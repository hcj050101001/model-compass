import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveMeasurements } from "@/lib/database/queries";
import { calculateParetoFrontier } from "@/lib/analytics/pareto";
import {
  DEFAULT_AGENT_PARAMS,
  LEGACY_AGENT_TEMPLATE_VERSION,
} from "@/lib/agent-cost/eac";
import {
  MULTI_TURN_TEMPLATE_VERSION,
  type DeveloperTaskProfile,
} from "@/lib/agent-cost/developer-cost";
import { getXAxisValue, isRealCostMode } from "@/lib/utils/format";
import type { MeasurementRow, XAxisMode, YAxisMetric } from "@/lib/analytics/types";

const QuerySchema = z.object({
  xMode: z
    .enum([
      "rasc",
      "real_p50",
      "eac",
      "input_price",
      "output_price",
      "cache_read_price",
      "custom_agent",
    ])
    .default("rasc"),
  yMetric: z.enum(["intelligence", "coding", "agentic"]).default("intelligence"),
  creator: z.string().optional(),
  // Only meaningful for xMode=eac; on other modes it is accepted and
  // ignored (design sec.2.5 request-compatibility rulings).
  taskProfile: z.enum(["light", "standard", "heavy"]).optional(),
});

/** Unit contract (design sec.2.5): one explicit unit per cost mode. */
const FRONTIER_COST_UNITS: Record<XAxisMode, string> = {
  rasc: "USD/effective task",
  real_p50: "USD/session",
  eac: "USD/simulated task",
  custom_agent: "USD/simulated task",
  input_price: "USD/million tokens",
  output_price: "USD/million tokens",
  cache_read_price: "USD/million tokens",
};

function getScoreForMetric(
  row: MeasurementRow,
  metric: YAxisMetric
): number | null {
  switch (metric) {
    case "intelligence":
      return row.intelligenceScore;
    case "coding":
      return row.codingScore;
    case "agentic":
      return row.agenticScore;
  }
}

function isSchemaCompatibilityError(err: unknown): boolean {
  return (
    err instanceof Error && err.name === "SchemaCompatibilityError"
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  // Duplicate query keys: Object.fromEntries keeps the LAST value; unknown
  // keys are stripped by the schema (design sec.2.5 compatibility rulings).
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries())
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid frontier query", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { xMode, yMetric, creator } = parsed.data;
  const taskProfile: DeveloperTaskProfile = parsed.data.taskProfile ?? "standard";

  let snapshot: Awaited<ReturnType<typeof getActiveMeasurements>>["snapshot"];
  let rows: MeasurementRow[];
  try {
    ({ snapshot, rows } = await getActiveMeasurements());
  } catch (err) {
    if (isSchemaCompatibilityError(err)) {
      return NextResponse.json(
        { error: "Service temporarily unavailable", code: "SCHEMA_INCOMPATIBLE" },
        { status: 503 }
      );
    }
    // Desensitized: never leak the underlying message, path or SQL.
    console.error("frontier: unexpected error", {
      name: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json(
      { error: "Internal server error", code: "INTERNAL" },
      { status: 500 }
    );
  }

  if (!snapshot) {
    // Controlled unavailability: the database answered but there is no
    // active snapshot to serve a frontier from.
    return NextResponse.json(
      { error: "Service temporarily unavailable", code: "NO_ACTIVE_SNAPSHOT" },
      { status: 503 }
    );
  }

  // Empty creator parameter = unrestricted; unknown slugs simply match no
  // rows and yield an empty candidate set (not an error).
  const creatorSlugs = creator
    ? Array.from(
        new Set(
          creator
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0)
        )
      )
    : [];
  const creatorFilter = creatorSlugs.length > 0 ? new Set(creatorSlugs) : null;

  const filtered = creatorFilter
    ? rows.filter((r) => creatorFilter.has(r.creatorSlug.toLowerCase()))
    : rows;

  const realOnly = isRealCostMode(xMode);
  const simulated = xMode === "eac" || xMode === "custom_agent";
  const points = filtered
    .map((r) => {
      const score = getScoreForMetric(r, yMetric);
      if (score === null || !Number.isFinite(score)) return null;

      if (realOnly) {
        // Measured modes: qualified A/B only, no fallback to estimates.
        // A qualified measured value of exactly 0 is a real measurement
        // and joins the frontier (design sec.2.5 D-5 / ADR-6).
        if (r.dataQuality.level !== "A" && r.dataQuality.level !== "B") {
          return null;
        }
        const cost = getXAxisValue(r, xMode as XAxisMode, DEFAULT_AGENT_PARAMS);
        if (cost === null || !Number.isFinite(cost) || cost < 0) return null;
        return {
          id: r.id,
          variantId: r.variantId,
          displayName: r.displayName,
          creatorName: r.creatorName,
          cost,
          score,
          indexVersion: r.indexVersion,
          qualityLevel: r.dataQuality.level,
        };
      }

      // Estimated / pricing modes: the point carries NO measured quality
      // level into Pareto (source grade is reported separately), so mixed
      // A/B/C/D source rows can never trip the mixed-tier guard.
      const cost = getXAxisValue(
        r,
        xMode as XAxisMode,
        DEFAULT_AGENT_PARAMS,
        taskProfile
      );
      if (cost === null || !Number.isFinite(cost)) return null;
      // Simulated candidates must be positive; pricing candidates keep a
      // legal 0 price.
      if (simulated ? cost <= 0 : cost < 0) return null;
      return {
        id: r.id,
        variantId: r.variantId,
        displayName: r.displayName,
        creatorName: r.creatorName,
        cost,
        score,
        indexVersion: r.indexVersion,
        sourceQualityLevel: r.dataQuality.level,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const result = calculateParetoFrontier(points, {
    indexVersion: snapshot.benchmarkVersion,
    allowedQualityLevels: realOnly ? ["A", "B"] : undefined,
  });

  const templateVersion =
    xMode === "eac"
      ? MULTI_TURN_TEMPLATE_VERSION
      : xMode === "custom_agent"
        ? LEGACY_AGENT_TEMPLATE_VERSION
        : null;

  return NextResponse.json({
    snapshotId: snapshot.id,
    snapshot_id: snapshot.id,
    indexVersion: snapshot.benchmarkVersion,
    xMode,
    yMetric,
    cost_mode: xMode,
    cost_unit: FRONTIER_COST_UNITS[xMode as XAxisMode],
    task_profile: xMode === "eac" ? taskProfile : null,
    template_version: templateVersion,
    candidate_scope: creatorFilter ? creatorSlugs : "all",
    dataQualityTier: realOnly ? "real_A_B" : "estimated_or_list_price",
    evaluatedCount: result.evaluatedCount,
    frontierIds: Array.from(result.frontierIds),
    frontier: result.frontier,
  });
}
