export interface BlendedPriceResult {
  blendedPricePerMillion: number;
  inputRatio: number;
  outputRatio: number;
}

export function calculateBlendedPrice(
  inputPricePerMillion: number | null,
  outputPricePerMillion: number | null,
  inputRatio = 0.75
): BlendedPriceResult | null {
  if (
    inputPricePerMillion === null ||
    outputPricePerMillion === null ||
    !Number.isFinite(inputPricePerMillion) ||
    !Number.isFinite(outputPricePerMillion)
  ) {
    return null;
  }
  const clampedInput = Math.min(1, Math.max(0, inputRatio));
  const outputRatio = Number((1 - clampedInput).toFixed(4));
  return {
    blendedPricePerMillion:
      clampedInput * inputPricePerMillion + outputRatio * outputPricePerMillion,
    inputRatio: clampedInput,
    outputRatio,
  };
}

export interface CustomWorkloadParams {
  inputTokensPerTask: number;
  cacheHitTokensPerTask: number;
  outputTokensPerTask: number;
  reasoningTokensPerTask: number;
  reasoningIncludedInOutput: boolean;
  tasksPerDay: number;
  workingDaysPerMonth: number;
}

export interface CustomWorkloadCostResult {
  perTaskUsd: number;
  dailyUsd: number;
  monthlyUsd: number;
  isEstimated: true;
  usedFallbackForCache: boolean;
}

export function calculateCustomWorkloadCost(
  pricing: {
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    cacheReadPricePerMillion: number | null;
  },
  params: CustomWorkloadParams
): CustomWorkloadCostResult | null {
  if (
    pricing.inputPricePerMillion === null ||
    pricing.outputPricePerMillion === null
  ) {
    return null;
  }

  const uncachedInputTokens = Math.max(
    0,
    params.inputTokensPerTask - params.cacheHitTokensPerTask
  );
  const effectiveCachePrice =
    pricing.cacheReadPricePerMillion ?? pricing.inputPricePerMillion;
  const usedFallbackForCache =
    params.cacheHitTokensPerTask > 0 &&
    pricing.cacheReadPricePerMillion === null;

  // Avoid double-counting reasoning tokens if already included in outputTokensPerTask
  const billableOutputTokens = params.reasoningIncludedInOutput
    ? Math.max(0, params.outputTokensPerTask)
    : Math.max(0, params.outputTokensPerTask + params.reasoningTokensPerTask);

  const inputCost =
    (uncachedInputTokens / 1_000_000) * pricing.inputPricePerMillion;
  const cacheCost =
    (Math.max(0, params.cacheHitTokensPerTask) / 1_000_000) *
    effectiveCachePrice;
  const outputCost =
    (billableOutputTokens / 1_000_000) * pricing.outputPricePerMillion;

  const perTaskUsd = inputCost + cacheCost + outputCost;
  const dailyUsd = perTaskUsd * Math.max(0, params.tasksPerDay);
  const monthlyUsd = dailyUsd * Math.max(0, params.workingDaysPerMonth);

  return {
    perTaskUsd,
    dailyUsd,
    monthlyUsd,
    isEstimated: true,
    usedFallbackForCache,
  };
}
