import config from "@/config/agent-cost-config.json";
import { DEFAULT_SCENARIO_WEIGHTS } from "./rasc";
import type { CustomAgentParams, TaskComplexity, TokenPricing } from "./types";

export interface EacCalculationResult {
  estimatedCostUsd: number;
  uncachedInputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  billableOutputTokens: number;
  usedCacheFallback: boolean;
  isEstimated: true;
}

export function getPresetAgentParams(preset: TaskComplexity): CustomAgentParams {
  const p = config.eacPresets[preset];
  return {
    preset,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    reasoningTokens: p.reasoningTokens,
    reasoningIncludedInOutput: p.reasoningIncludedInOutput,
    cacheHitRate: p.cacheHitRate,
    cacheWriteTokens: p.cacheWriteTokens,
    apiCalls: p.apiCalls,
    scenario: "bug_fix",
    complexity: preset,
    includeExtraToolCost: false,
    scenarioWeights: { ...DEFAULT_SCENARIO_WEIGHTS },
  };
}

export const DEFAULT_AGENT_PARAMS: CustomAgentParams = getPresetAgentParams("medium");

/**
 * Legacy single-pass template identifier (the implicit v1 predating the
 * multi-turn template "mt-v2" in developer-cost.ts). Used to label
 * custom_agent amounts and legacy derived values in API/export payloads.
 */
export const LEGACY_AGENT_TEMPLATE_VERSION = "legacy-v1";

/**
 * Standardized Estimated Agent Cost (EAC):
 * EAC = (U * P_input + C * P_cache_read + W * P_cache_write + O * P_output) / 1_000_000
 *
 * IMPORTANT:
 * - inputTokens, outputTokens, reasoningTokens, cacheWriteTokens are cumulative session totals.
 *   They are NEVER multiplied by apiCalls.
 * - Reasoning tokens are NOT double-counted when reasoningIncludedInOutput is true.
 * - Returns null if official input or output price is missing.
 */
export function calculateEAC(
  pricing: TokenPricing,
  params: Pick<
    CustomAgentParams,
    | "inputTokens"
    | "outputTokens"
    | "reasoningTokens"
    | "reasoningIncludedInOutput"
    | "cacheHitRate"
    | "cacheWriteTokens"
  >
): EacCalculationResult | null {
  // Required prices: missing, non-finite or negative prices are rejected
  // (Package D boundary rules); 0 is a legal price.
  if (
    pricing.inputPerMillion === null ||
    pricing.outputPerMillion === null ||
    !Number.isFinite(pricing.inputPerMillion) ||
    !Number.isFinite(pricing.outputPerMillion) ||
    pricing.inputPerMillion < 0 ||
    pricing.outputPerMillion < 0
  ) {
    return null;
  }

  const totalInput = Math.max(0, params.inputTokens);
  const clampedHitRate = Math.min(1, Math.max(0, params.cacheHitRate));
  const cachedReadTokens = Math.round(totalInput * clampedHitRate);
  const cacheWriteTokens = Math.max(0, params.cacheWriteTokens);
  const uncachedInputTokens = Math.max(0, totalInput - cachedReadTokens);

  const billableOutputTokens = params.reasoningIncludedInOutput
    ? Math.max(0, params.outputTokens)
    : Math.max(0, params.outputTokens) + Math.max(0, params.reasoningTokens);

  // Cache prices: invalid (negative / non-finite) values are treated as
  // missing, never as discounts; a valid 0 is kept.
  const cacheReadValid =
    pricing.cacheReadPerMillion !== null &&
    Number.isFinite(pricing.cacheReadPerMillion) &&
    pricing.cacheReadPerMillion >= 0;
  const cacheWriteValid =
    pricing.cacheWritePerMillion !== null &&
    Number.isFinite(pricing.cacheWritePerMillion) &&
    pricing.cacheWritePerMillion >= 0;
  const usedCacheFallback = cachedReadTokens > 0 && !cacheReadValid;
  const effectiveCacheReadPrice = cacheReadValid
    ? (pricing.cacheReadPerMillion as number)
    : pricing.inputPerMillion;
  const effectiveCacheWritePrice = cacheWriteValid
    ? (pricing.cacheWritePerMillion as number)
    : 0;

  const estimatedCostUsd =
    (uncachedInputTokens * pricing.inputPerMillion +
      cachedReadTokens * effectiveCacheReadPrice +
      cacheWriteTokens * effectiveCacheWritePrice +
      billableOutputTokens * pricing.outputPerMillion) /
    1_000_000;

  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
    return null;
  }

  return {
    estimatedCostUsd,
    uncachedInputTokens,
    cachedReadTokens,
    cacheWriteTokens,
    billableOutputTokens,
    usedCacheFallback,
    isEstimated: true,
  };
}
