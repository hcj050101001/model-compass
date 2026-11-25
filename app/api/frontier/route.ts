import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveMeasurements } from "@/lib/database/queries";
import { calculateParetoFrontier } from "@/lib/analytics/pareto";
import { DEFAULT_AGENT_PARAMS } from "@/lib/agent-cost/eac";
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
});

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

export async function GET(request: Request) {
  const url = new URL(request.url);
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
  const { snapshot, rows } = await getActiveMeasurements();

  const creatorFilter = creator
    ? new Set(creator.split(",").map((s) => s.trim().toLowerCase()))
    : null;

  const filtered = creatorFilter
    ? rows.filter((r) => creatorFilter.has(r.creatorSlug.toLowerCase()))
    : rows;

  const realOnly = isRealCostMode(xMode);
  const points = filtered
    .map((r) => {
      if (realOnly && r.dataQuality.level !== "A" && r.dataQuality.level !== "B") {
        return null;
      }
      const cost = getXAxisValue(r, xMode as XAxisMode, DEFAULT_AGENT_PARAMS);
      const score = getScoreForMetric(r, yMetric);
      if (cost === null || score === null) return null;
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
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const result = calculateParetoFrontier(points, {
    indexVersion: snapshot?.benchmarkVersion,
    allowedQualityLevels: realOnly ? ["A", "B"] : undefined,
  });

  return NextResponse.json({
    snapshotId: snapshot?.id ?? null,
    indexVersion: snapshot?.benchmarkVersion ?? null,
    xMode,
    yMetric,
    dataQualityTier: realOnly ? "real_A_B" : "estimated_or_list_price",
    evaluatedCount: result.evaluatedCount,
    frontierIds: Array.from(result.frontierIds),
    frontier: result.frontier,
  });
}
