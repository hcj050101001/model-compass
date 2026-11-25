import type { AAModelItem } from "./schema";
import type { PricingProvenance } from "@/lib/agent-cost/types";
import { makeProvenance } from "@/lib/data-sources/model-mappings";
import { resolveCreator, type ResolvedCreator } from "@/lib/normalization/creators";
import {
  extractModelFamily,
  parseEffortAndRelease,
  type EffortLadderType,
} from "@/lib/normalization/effort";

export interface NormalizedBundle {
  creators: ResolvedCreator[];
  releases: Array<{
    id: string;
    creatorId: string;
    family: string;
    name: string;
    version: string | null;
    releaseDate: string | null;
    contextWindow: number | null;
    isOpenWeights: boolean | null;
    sourceUrl: string | null;
  }>;
  variants: Array<{
    id: string;
    modelReleaseId: string;
    sourceId: string;
    sourceSlug: string;
    rawName: string;
    displayName: string;
    effortRaw: string | null;
    effortNormalized: string | null;
    effortOrder: number | null;
    effortLadderType: EffortLadderType;
    isReasoningModel: boolean | null;
    isGrouped: boolean;
  }>;
  measurements: Array<{
    id: string;
    variantId: string;
    source: string;
    sourceUrl: string;
    indexName: string;
    indexVersion: string;
    intelligenceScore: number | null;
    codingScore: number | null;
    agenticScore: number | null;
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    cacheReadPricePerMillion: number | null;
    cacheWritePricePerMillion: number | null;
    outputTokensPerSecond: number | null;
    timeToFirstToken: number | null;
    timePerTask: number | null;
    measuredAt: string | null;
    fetchedAt: string;
    pricingSource: string | null;
    fieldSources?: PricingProvenance;
  }>;
  rejectedCount: number;
}

function slugify(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isFiniteOrNull(val: unknown): number | null {
  return typeof val === "number" && Number.isFinite(val) ? val : null;
}

/**
 * Package C: AA prices must be finite and non-negative. Negative or
 * non-finite values are rejected (treated as missing, never written as 0);
 * a genuine zero price is valid and preserved.
 */
function validPriceOrNull(val: unknown): number | null {
  return typeof val === "number" && Number.isFinite(val) && val >= 0
    ? val
    : null;
}

export function mapAAModelsToNormalized(params: {
  items: AAModelItem[];
  indexVersion: string;
  fetchedAt: string;
  source?: string;
}): NormalizedBundle {
  const { items, indexVersion, fetchedAt, source = "artificial-analysis" } = params;

  const creatorMap = new Map<string, ResolvedCreator>();
  const releaseMap = new Map<string, NormalizedBundle["releases"][number]>();
  const variants: NormalizedBundle["variants"] = [];
  const measurements: NormalizedBundle["measurements"] = [];
  const seenSourceIds = new Set<string>();
  let rejectedCount = 0;

  for (const item of items) {
    if (!item.id || !item.name || !item.slug) {
      rejectedCount += 1;
      continue;
    }

    if (seenSourceIds.has(item.id)) {
      continue;
    }
    seenSourceIds.add(item.id);

    const creator = resolveCreator({
      id: item.model_creator?.id,
      name: item.model_creator?.name,
      slug: item.model_creator?.slug,
    });
    creatorMap.set(creator.id, creator);

    const parsedEffort = parseEffortAndRelease({
      rawName: item.name,
      slug: item.slug,
      structuredEffort: item.reasoning_effort ?? item.effort ?? null,
    });

    // Release key includes creator + normalized baseName + releaseDate (if present) so distinct versions don't falsely merge
    const releaseKey = `${creator.slug}::${slugify(parsedEffort.baseName)}::${item.release_date ?? "undated"}`;
    const releaseId = `rel_${slugify(releaseKey)}`;

    if (!releaseMap.has(releaseId)) {
      releaseMap.set(releaseId, {
        id: releaseId,
        creatorId: creator.id,
        family: extractModelFamily(parsedEffort.baseName),
        name: parsedEffort.baseName,
        version: item.release_date ?? null,
        releaseDate: item.release_date ?? null,
        contextWindow: isFiniteOrNull(item.context_window),
        isOpenWeights:
          typeof item.is_open_weights === "boolean" ? item.is_open_weights : null,
        sourceUrl: `https://artificialanalysis.ai/models/${item.slug}`,
      });
    }

    const variantId = `var_${slugify(item.id)}`;
    variants.push({
      id: variantId,
      modelReleaseId: releaseId,
      sourceId: item.id,
      sourceSlug: item.slug,
      rawName: item.name,
      displayName: parsedEffort.effortNormalized
        ? `${parsedEffort.baseName} (${parsedEffort.effortNormalized})`
        : item.name,
      effortRaw: parsedEffort.effortRaw,
      effortNormalized: parsedEffort.effortNormalized,
      effortOrder: parsedEffort.effortOrder,
      effortLadderType: parsedEffort.effortLadderType,
      isReasoningModel: parsedEffort.isReasoningModel,
      isGrouped: parsedEffort.isGrouped,
    });

    const inputPricePerMillion = validPriceOrNull(item.pricing?.price_1m_input_tokens);
    const outputPricePerMillion = validPriceOrNull(item.pricing?.price_1m_output_tokens);
    const cacheReadPricePerMillion = validPriceOrNull(
      item.pricing?.price_1m_cache_read_tokens
    );
    const cacheWritePricePerMillion = validPriceOrNull(
      item.pricing?.price_1m_cache_write_tokens
    );

    // Per-field provenance: AA has no trusted quote-time contract, so
    // observedAt stays null (never filled with sync or release dates).
    const fieldSources: PricingProvenance = {};
    const aaProv = (key: string) =>
      makeProvenance({ source, upstreamKey: key, observedAt: null });
    if (inputPricePerMillion !== null) fieldSources.input = aaProv(item.id);
    if (outputPricePerMillion !== null) fieldSources.output = aaProv(item.id);
    if (cacheReadPricePerMillion !== null) fieldSources.cacheRead = aaProv(item.id);
    if (cacheWritePricePerMillion !== null) fieldSources.cacheWrite = aaProv(item.id);
    if (isFiniteOrNull(item.context_window) !== null) {
      fieldSources.contextWindow = makeProvenance({
        source,
        upstreamKey: item.id,
        currency: null,
        unit: "tokens",
        observedAt: null,
      });
    }

    const outputTokensPerSecond =
      isFiniteOrNull(item.performance_v3?.median_output_tokens_per_second) ??
      isFiniteOrNull(item.performance_v3?.mean_output_tokens_per_second);
    const timeToFirstToken =
      isFiniteOrNull(item.performance_v3?.median_time_to_first_token_seconds) ??
      isFiniteOrNull(item.performance_v3?.mean_time_to_first_token_seconds);
    const timePerTask = isFiniteOrNull(item.performance_v3?.time_per_task_seconds);

    measurements.push({
      id: `meas_${variantId}_${slugify(indexVersion)}`,
      variantId,
      source,
      sourceUrl: `https://artificialanalysis.ai/models/${item.slug}`,
      indexName: "AA Intelligence Index",
      indexVersion,
      intelligenceScore: isFiniteOrNull(
        item.evaluations?.artificial_analysis_intelligence_index
      ),
      codingScore: isFiniteOrNull(item.evaluations?.artificial_analysis_coding_index),
      agenticScore: isFiniteOrNull(item.evaluations?.artificial_analysis_agentic_index),
      inputPricePerMillion,
      outputPricePerMillion,
      cacheReadPricePerMillion,
      cacheWritePricePerMillion,
      outputTokensPerSecond,
      timeToFirstToken,
      timePerTask,
      measuredAt: item.release_date ?? null,
      fetchedAt,
      pricingSource:
        inputPricePerMillion !== null ||
        outputPricePerMillion !== null ||
        cacheReadPricePerMillion !== null ||
        cacheWritePricePerMillion !== null
          ? source
          : null,
      fieldSources,
    });
  }

  return {
    creators: Array.from(creatorMap.values()),
    releases: Array.from(releaseMap.values()),
    variants,
    measurements,
    rejectedCount,
  };
}
