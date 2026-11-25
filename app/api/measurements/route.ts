import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveMeasurements } from "@/lib/database/queries";

const QuerySchema = z.object({
  creator: z.string().optional(),
  effort: z.string().optional(),
  minScore: z.coerce.number().optional(),
  maxCost: z.coerce.number().optional(),
  reasoningOnly: z.enum(["true", "false"]).optional(),
  openWeightsOnly: z.enum(["true", "false"]).optional(),
  search: z.string().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawParams = Object.fromEntries(url.searchParams.entries());
  const parsed = QuerySchema.safeParse(rawParams);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { snapshot, rows } = await getActiveMeasurements();
  const q = parsed.data;
  const creatorFilter = q.creator
    ? new Set(q.creator.split(",").map((s) => s.trim().toLowerCase()))
    : null;
  const effortFilter = q.effort
    ? new Set(q.effort.split(",").map((s) => s.trim().toLowerCase()))
    : null;
  const searchLower = q.search?.trim().toLowerCase();

  const filtered = rows.filter((r) => {
    if (creatorFilter && !creatorFilter.has(r.creatorSlug.toLowerCase())) {
      return false;
    }
    if (effortFilter) {
      const eff = (r.effortNormalized ?? "standard").toLowerCase();
      if (!effortFilter.has(eff)) return false;
    }
    if (
      q.minScore !== undefined &&
      (r.intelligenceScore === null || r.intelligenceScore < q.minScore)
    ) {
      return false;
    }
    if (
      q.maxCost !== undefined &&
      ((r.agentCost.rasc ?? r.agentCost.estimated_cost) === null ||
        (r.agentCost.rasc ?? r.agentCost.estimated_cost)! > q.maxCost)
    ) {
      return false;
    }
    if (q.reasoningOnly === "true" && !r.isReasoningModel) {
      return false;
    }
    if (q.openWeightsOnly === "true" && !r.isOpenWeights) {
      return false;
    }
    if (searchLower) {
      const hay = `${r.displayName} ${r.rawName} ${r.creatorName} ${r.family}`.toLowerCase();
      if (!hay.includes(searchLower)) return false;
    }
    return true;
  });

  return NextResponse.json({
    snapshot,
    totalCount: filtered.length,
    measurements: filtered,
  });
}
