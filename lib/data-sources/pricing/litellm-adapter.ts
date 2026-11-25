import type { NormalizedBundle } from "../artificial-analysis/mapper";

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const DIRECT_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "gemini",
  "google",
  "deepseek",
  "xai",
  "dashscope",
  "moonshot",
  "zhipu",
  "minimax",
  "mistral",
]);

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
}

function normalizeModelKey(str: string): string {
  return str
    .toLowerCase()
    .replace(/^[^/]+\//, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function toPerMillion(perToken: unknown): number | null {
  if (typeof perToken !== "number" || !Number.isFinite(perToken) || perToken < 0) {
    return null;
  }
  return Number((perToken * 1_000_000).toFixed(6));
}

/**
 * Fetches official model token & cache pricing from LiteLLM's deterministic
 * community-maintained official pricing catalog (no API key required).
 * Prefers direct provider entries over cloud resellers (bedrock/vertex/azure).
 * Only backfills missing fields; never overwrites already-populated official prices.
 */
export async function enrichWithLiteLLMPricing(
  bundle: NormalizedBundle,
  options?: { url?: string; fetchImpl?: typeof fetch }
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

  // Index by normalized model name, keeping highest priority (direct provider > others)
  const index = new Map<
    string,
    {
      isDirect: boolean;
      input: number | null;
      output: number | null;
      cacheRead: number | null;
      cacheWrite: number | null;
    }
  >();

  for (const [key, entry] of catalogEntries) {
    const norm = normalizeModelKey(key);
    if (!norm) continue;
    const isDirect = DIRECT_PROVIDERS.has(
      (entry.litellm_provider ?? "").toLowerCase()
    );
    const existing = index.get(norm);
    const candidate = {
      isDirect,
      input: toPerMillion(entry.input_cost_per_token),
      output: toPerMillion(entry.output_cost_per_token),
      cacheRead: toPerMillion(entry.cache_read_input_token_cost),
      cacheWrite: toPerMillion(entry.cache_creation_input_token_cost),
    };

    if (!existing) {
      index.set(norm, candidate);
    } else if (!existing.isDirect && candidate.isDirect) {
      index.set(norm, candidate);
    } else if (
      existing.isDirect === candidate.isDirect &&
      existing.cacheRead === null &&
      candidate.cacheRead !== null
    ) {
      index.set(norm, {
        ...existing,
        cacheRead: candidate.cacheRead,
        cacheWrite: existing.cacheWrite ?? candidate.cacheWrite,
      });
    }
  }

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
    const match = index.get(normalizeModelKey(rel.name));
    if (!match) continue;

    let updated = false;
    if (meas.inputPricePerMillion === null && match.input !== null) {
      meas.inputPricePerMillion = match.input;
      updated = true;
    }
    if (meas.outputPricePerMillion === null && match.output !== null) {
      meas.outputPricePerMillion = match.output;
      updated = true;
    }
    if (meas.cacheReadPricePerMillion === null && match.cacheRead !== null) {
      meas.cacheReadPricePerMillion = match.cacheRead;
      updated = true;
    }
    if (meas.cacheWritePricePerMillion === null && match.cacheWrite !== null) {
      meas.cacheWritePricePerMillion = match.cacheWrite;
      updated = true;
    }

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
