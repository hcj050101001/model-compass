import { fetchOpenRouterModels } from "./client";
import type { NormalizedBundle } from "../artificial-analysis/mapper";

function normalizeNameForMatch(name: string): string {
  return name
    .toLowerCase()
    .replace(/^[^:]+:\s*/, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parsePerMillion(perTokenStr: string | undefined): number | null {
  if (!perTokenStr) return null;
  const n = Number(perTokenStr);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1_000_000).toFixed(6));
}

/**
 * Enriches normalized model releases with context_window metadata and missing
 * token/cache pricing from OpenRouter.
 * Never overwrites Artificial Analysis intelligence scores or existing official prices.
 */
export async function enrichWithOpenRouter(
  bundle: NormalizedBundle,
  options?: { baseUrl?: string; fetchImpl?: typeof fetch }
): Promise<{ enrichedReleases: number; enrichedPricing: number }> {
  const models = await fetchOpenRouterModels(options);
  const byNormalizedName = new Map<
    string,
    {
      contextLength: number | null;
      inputPerMillion: number | null;
      outputPerMillion: number | null;
      cacheReadPerMillion: number | null;
      cacheWritePerMillion: number | null;
    }
  >();

  for (const m of models) {
    const key = normalizeNameForMatch(m.name);
    if (!key || byNormalizedName.has(key)) continue;
    byNormalizedName.set(key, {
      contextLength:
        typeof m.context_length === "number" && m.context_length > 0
          ? m.context_length
          : null,
      inputPerMillion: parsePerMillion(m.pricing?.prompt),
      outputPerMillion: parsePerMillion(m.pricing?.completion),
      cacheReadPerMillion: parsePerMillion(m.pricing?.input_cache_read),
      cacheWritePerMillion: parsePerMillion(m.pricing?.input_cache_write),
    });
  }

  let enrichedReleases = 0;
  const releaseById = new Map(bundle.releases.map((r) => [r.id, r]));
  const releaseByVariantId = new Map<string, (typeof bundle.releases)[number]>();

  for (const v of bundle.variants) {
    const rel = releaseById.get(v.modelReleaseId);
    if (rel) releaseByVariantId.set(v.id, rel);
  }

  for (const release of bundle.releases) {
    const key = normalizeNameForMatch(release.name);
    const meta = byNormalizedName.get(key);
    if (release.contextWindow === null && meta?.contextLength) {
      release.contextWindow = meta.contextLength;
      enrichedReleases += 1;
    }
  }

  let enrichedPricing = 0;
  for (const meas of bundle.measurements) {
    const rel = releaseByVariantId.get(meas.variantId);
    if (!rel) continue;
    const meta = byNormalizedName.get(normalizeNameForMatch(rel.name));
    if (!meta) continue;

    let updated = false;
    if (meas.inputPricePerMillion === null && meta.inputPerMillion !== null) {
      meas.inputPricePerMillion = meta.inputPerMillion;
      updated = true;
    }
    if (meas.outputPricePerMillion === null && meta.outputPerMillion !== null) {
      meas.outputPricePerMillion = meta.outputPerMillion;
      updated = true;
    }
    if (meas.cacheReadPricePerMillion === null && meta.cacheReadPerMillion !== null) {
      meas.cacheReadPricePerMillion = meta.cacheReadPerMillion;
      updated = true;
    }
    if (meas.cacheWritePricePerMillion === null && meta.cacheWritePerMillion !== null) {
      meas.cacheWritePricePerMillion = meta.cacheWritePerMillion;
      updated = true;
    }
    if (updated) {
      meas.pricingSource = meas.pricingSource
        ? `${meas.pricingSource}+openrouter`
        : "openrouter";
      enrichedPricing += 1;
    }
  }

  return { enrichedReleases, enrichedPricing };
}
