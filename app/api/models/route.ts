import { NextResponse } from "next/server";
import { getActiveMeasurements } from "@/lib/database/queries";

export async function GET() {
  const { snapshot, rows } = await getActiveMeasurements();
  const releasesMap = new Map<
    string,
    {
      id: string;
      creatorId: string;
      creatorName: string;
      creatorSlug: string;
      creatorColor: string;
      family: string;
      name: string;
      releaseDate: string | null;
      contextWindow: number | null;
      isOpenWeights: boolean | null;
      sourceUrl: string;
      variants: Array<{
        variantId: string;
        displayName: string;
        effortNormalized: string | null;
        effortOrder: number | null;
        isReasoningModel: boolean | null;
        intelligenceScore: number | null;
        rascUsd: number | null;
        estimatedCostUsd: number | null;
        dataQualityLevel: string;
      }>;
    }
  >();

  for (const r of rows) {
    let rel = releasesMap.get(r.releaseId);
    if (!rel) {
      rel = {
        id: r.releaseId,
        creatorId: r.creatorId,
        creatorName: r.creatorName,
        creatorSlug: r.creatorSlug,
        creatorColor: r.creatorColor,
        family: r.family,
        name: r.releaseName,
        releaseDate: r.releaseDate,
        contextWindow: r.contextWindow,
        isOpenWeights: r.isOpenWeights,
        sourceUrl: r.sourceUrl,
        variants: [],
      };
      releasesMap.set(r.releaseId, rel);
    }
    rel.variants.push({
      variantId: r.variantId,
      displayName: r.displayName,
      effortNormalized: r.effortNormalized,
      effortOrder: r.effortOrder,
      isReasoningModel: r.isReasoningModel,
      intelligenceScore: r.intelligenceScore,
      rascUsd: r.agentCost.rasc,
      estimatedCostUsd: r.agentCost.estimated_cost,
      dataQualityLevel: r.dataQuality.level,
    });
  }

  for (const rel of releasesMap.values()) {
    rel.variants.sort((a, b) => (a.effortOrder ?? 999) - (b.effortOrder ?? 999));
  }

  return NextResponse.json({
    snapshotId: snapshot?.id ?? null,
    isDemo: snapshot?.isDemo ?? true,
    models: Array.from(releasesMap.values()),
  });
}
