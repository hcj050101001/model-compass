import { fetchOpenRouterModels } from "./client";
import type { NormalizedBundle } from "../artificial-analysis/mapper";
import {
  findVerifiedMapping,
  loadVerifiedChannelMappings,
  makeProvenance,
  parseStrictDecimalPrice,
  type VerifiedChannelMapping,
} from "../model-mappings";

/**
 * Package C: OpenRouter data may only fill EMPTY pricing fields (and an
 * empty context window), and only for a release bound to an exact OpenRouter
 * catalog id by a maintainer-verified entry in config/model-mappings.json.
 * Display-name matching and first-candidate wins are not identity evidence
 * and are never used. Prices are parsed strictly (plain decimal strings
 * only); invalid values are rejected and never written as 0. Every filled
 * field records field-level provenance.
 */
export async function enrichWithOpenRouter(
  bundle: NormalizedBundle,
  options?: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    mappings?: VerifiedChannelMapping[];
  }
): Promise<{ enrichedReleases: number; enrichedPricing: number }> {
  const models = await fetchOpenRouterModels(options);
  const byId = new Map(models.map((m) => [m.id, m]));
  const mappings = options?.mappings ?? loadVerifiedChannelMappings();

  const creatorSlugById = new Map(bundle.creators.map((c) => [c.id, c.slug]));
  const releaseById = new Map(bundle.releases.map((r) => [r.id, r]));
  const releaseByVariantId = new Map<string, (typeof bundle.releases)[number]>();
  for (const v of bundle.variants) {
    const rel = releaseById.get(v.modelReleaseId);
    if (rel) releaseByVariantId.set(v.id, rel);
  }

  const mappingFor = (rel: (typeof bundle.releases)[number]) => {
    const creatorSlug = creatorSlugById.get(rel.creatorId);
    if (!creatorSlug) return null;
    return findVerifiedMapping({
      channel: "openrouter",
      creatorSlug,
      releaseName: rel.name,
      releaseDate: rel.releaseDate,
      mappings,
    });
  };

  let enrichedReleases = 0;
  for (const release of bundle.releases) {
    if (release.contextWindow !== null) continue;
    const mapping = mappingFor(release);
    if (!mapping) continue;
    const model = byId.get(mapping.upstreamKey);
    if (!model) continue;
    if (
      typeof model.context_length === "number" &&
      Number.isSafeInteger(model.context_length) &&
      model.context_length > 0
    ) {
      release.contextWindow = model.context_length;
      enrichedReleases += 1;
    }
  }

  let enrichedPricing = 0;
  for (const meas of bundle.measurements) {
    const rel = releaseByVariantId.get(meas.variantId);
    if (!rel) continue;
    const mapping = mappingFor(rel);
    if (!mapping) continue;
    const model = byId.get(mapping.upstreamKey);
    if (!model) continue;

    const candidate = {
      input: parseStrictDecimalPrice(model.pricing?.prompt),
      output: parseStrictDecimalPrice(model.pricing?.completion),
      cacheRead: parseStrictDecimalPrice(model.pricing?.input_cache_read),
      cacheWrite: parseStrictDecimalPrice(model.pricing?.input_cache_write),
    };

    let updated = false;
    const fill = (
      field: "input" | "output" | "cacheRead" | "cacheWrite",
      prop:
        | "inputPricePerMillion"
        | "outputPricePerMillion"
        | "cacheReadPricePerMillion"
        | "cacheWritePricePerMillion",
      value: number | null
    ) => {
      if (meas[prop] === null && value !== null) {
        meas[prop] = value;
        meas.fieldSources = meas.fieldSources ?? {};
        meas.fieldSources[field] = makeProvenance({
          source: "openrouter",
          upstreamKey: mapping.upstreamKey,
          observedAt: null,
        });
        updated = true;
      }
    };
    fill("input", "inputPricePerMillion", candidate.input);
    fill("output", "outputPricePerMillion", candidate.output);
    fill("cacheRead", "cacheReadPricePerMillion", candidate.cacheRead);
    fill("cacheWrite", "cacheWritePricePerMillion", candidate.cacheWrite);

    if (updated) {
      meas.pricingSource = meas.pricingSource
        ? `${meas.pricingSource}+openrouter`
        : "openrouter";
      enrichedPricing += 1;
    }
  }

  return { enrichedReleases, enrichedPricing };
}
