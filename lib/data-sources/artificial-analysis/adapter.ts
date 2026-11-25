import { fetchAllAAModels, type AAClientConfig } from "./client";
import { mapAAModelsToNormalized, type NormalizedBundle } from "./mapper";

export interface AAAdapterResult {
  bundle: NormalizedBundle;
  indexVersion: string;
  tier: string;
  fetchedCount: number;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitReset: string | null;
}

export async function runArtificialAnalysisAdapter(
  config: AAClientConfig
): Promise<AAAdapterResult> {
  const fetchedAt = new Date().toISOString();
  const result = await fetchAllAAModels(config);
  const bundle = mapAAModelsToNormalized({
    items: result.items,
    indexVersion: result.indexVersion,
    fetchedAt,
    source: "artificial-analysis",
  });

  return {
    bundle,
    indexVersion: result.indexVersion,
    tier: result.tier,
    fetchedCount: result.items.length,
    rateLimitLimit: result.rateLimitLimit,
    rateLimitRemaining: result.rateLimitRemaining,
    rateLimitReset: result.rateLimitReset,
  };
}
