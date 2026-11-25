import type { NormalizedBundle } from "../artificial-analysis/mapper";
import {
  findVerifiedMapping,
  loadVerifiedChannelMappings,
  makeProvenance,
  perTokenToPerMillion,
  type VerifiedChannelMapping,
} from "../model-mappings";

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
}

/**
 * Package C: LiteLLM pricing may only fill EMPTY fields, and only for a
 * release bound to an exact catalog key by a maintainer-verified entry in
 * config/model-mappings.json. Name-based matching, candidate ordering and
 * provider heuristics are not identity evidence and are never used; when no
 * verified mapping exists (or it is ambiguous) the field stays empty.
 * Invalid prices (negative, non-finite, overflow, non-zero rounding to 0)
 * are rejected and never written as 0. Every filled field records
 * field-level provenance.
 */
export async function enrichWithLiteLLMPricing(
  bundle: NormalizedBundle,
  options?: {
    url?: string;
    fetchImpl?: typeof fetch;
    mappings?: VerifiedChannelMapping[];
  }
): Promise<{ enrichedMeasurements: number; catalogSize: number }> {
  const fetchFn = options?.fetchImpl ?? fetch;
  const url = options?.url ?? LITELLM_PRICING_URL;
  const res = await fetchFn(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`LiteLLM pricing fetch failed with HTTP ${res.status}`);
  }

  const rawCatalog = (await res.json()) as Record<string, LiteLLMEntry>;
  const catalogEntries = Object.entries(rawCatalog).filter(
    ([k, v]) => k !== "sample_spec" && v && typeof v === "object" && (!v.mode || v.mode === "chat")
  );
  const catalog = new Map(catalogEntries);
  const mappings = options?.mappings ?? loadVerifiedChannelMappings();

  const creatorSlugById = new Map(bundle.creators.map((c) => [c.id, c.slug]));
  const releaseById = new Map(bundle.releases.map((r) => [r.id, r]));
  const releaseByVariantId = new Map<string, (typeof bundle.releases)[number]>();
  for (const v of bundle.variants) {
    const rel = releaseById.get(v.modelReleaseId);
    if (rel) releaseByVariantId.set(v.id, rel);
  }

  let enrichedMeasurements = 0;
  for (const meas of bundle.measurements) {
    const rel = releaseByVariantId.get(meas.variantId);
    if (!rel) continue;
    const creatorSlug = creatorSlugById.get(rel.creatorId);
    if (!creatorSlug) continue;
    const mapping = findVerifiedMapping({
      channel: "litellm",
      creatorSlug,
      releaseName: rel.name,
      releaseDate: rel.releaseDate,
      mappings,
    });
    if (!mapping) continue;
    const entry = catalog.get(mapping.upstreamKey);
    if (!entry) continue;

    const candidate = {
      input: perTokenToPerMillion(entry.input_cost_per_token),
      output: perTokenToPerMillion(entry.output_cost_per_token),
      cacheRead: perTokenToPerMillion(entry.cache_read_input_token_cost),
      cacheWrite: perTokenToPerMillion(entry.cache_creation_input_token_cost),
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
          source: "litellm",
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
        ? `${meas.pricingSource}+litellm`
        : "litellm";
      enrichedMeasurements += 1;
    }
  }

  return {
    enrichedMeasurements,
    catalogSize: catalogEntries.length,
  };
}
