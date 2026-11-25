import type { TokenPricing } from "./types";

export type DeveloperTaskProfile = "light" | "standard" | "heavy";

export interface DeveloperTaskSpec {
  id: DeveloperTaskProfile;
  labelZh: string;
  labelEn: string;
  avgContextTokens: number;
  peakContextTokens: number;
  turns: number;
  initialContextTokens: number;
  deltaTokensPerTurn: number;
  visibleOutputPerTurn: number;
}

export const DEVELOPER_TASK_PROFILES: Record<
  DeveloperTaskProfile,
  DeveloperTaskSpec
> = {
  light: {
    id: "light",
    labelZh: "轻量 (~20K)",
    labelEn: "Light (~20K)",
    avgContextTokens: 20_000,
    peakContextTokens: 30_000,
    turns: 6,
    initialContextTokens: 10_000,
    deltaTokensPerTurn: 3_400,
    visibleOutputPerTurn: 600,
  },
  standard: {
    id: "standard",
    labelZh: "标准 (~64K)",
    labelEn: "Standard (~64K)",
    avgContextTokens: 64_000,
    peakContextTokens: 104_000,
    turns: 11,
    initialContextTokens: 24_000,
    deltaTokensPerTurn: 7_100,
    visibleOutputPerTurn: 900,
  },
  heavy: {
    id: "heavy",
    labelZh: "重度 (~160K)",
    labelEn: "Heavy (~160K)",
    avgContextTokens: 160_000,
    peakContextTokens: 272_000,
    turns: 17,
    initialContextTokens: 48_000,
    deltaTokensPerTurn: 12_800,
    visibleOutputPerTurn: 1_200,
  },
};

/**
 * Classifies a task's scale using Context-Weighted Effective Load:
 *   C_eff = avgContextTokens + 4 * avgOutputTokensPerTurn
 *
 * Unlike naive turn-counting, this keeps high-turn tasks with small base context
 * (e.g., 2K x 20 turns) in "light", while classifying deep research or large-repo
 * tasks with large average context (e.g., 140K x 6 turns) as "heavy".
 */
export function classifyTaskScale(input: {
  avgContextTokens: number;
  turns?: number;
  avgOutputTokensPerTurn?: number;
}): { profile: DeveloperTaskProfile; effectiveContextLoad: number } {
  const avgCtx = Math.max(0, input.avgContextTokens);
  const avgOut = Math.max(0, input.avgOutputTokensPerTurn ?? 800);
  const effectiveContextLoad = Math.round(avgCtx + 4 * avgOut);

  if (avgCtx < 36_000 && effectiveContextLoad < 44_000) {
    return { profile: "light", effectiveContextLoad };
  }
  if (avgCtx < 110_000 && effectiveContextLoad < 120_000) {
    return { profile: "standard", effectiveContextLoad };
  }
  return { profile: "heavy", effectiveContextLoad };
}

export function getThinkingTokensPerTurn(
  effortNormalized: string | null | undefined,
  isReasoningModel: boolean | null | undefined
): number {
  const norm = (effortNormalized ?? "").trim().toLowerCase();
  if (!norm) {
    return isReasoningModel === false ? 0 : 1_500;
  }
  if (norm.startsWith("non-thinking") || norm === "standard" || norm === "none") {
    return 0;
  }
  if (norm === "minimal") return 300;
  if (norm === "low") return 900;
  if (norm === "medium" || norm === "adaptive") return 2_200;
  if (norm === "high") return 4_800;
  if (norm === "very high" || norm === "xhigh") return 8_000;
  if (norm === "max") return 12_000;
  return isReasoningModel === false ? 0 : 2_200;
}

export interface DeveloperAgentCostBreakdown {
  totalUsd: number;
  inputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  outputCostUsd: number;
  uncachedInputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  compactionCount: number;
  cacheSavingsUsd: number;
  turns: number;
  avgContextTokens: number;
  peakContextTokens: number;
  profile: DeveloperTaskProfile;
  explicitCacheWrite: boolean;
  hasCacheDiscount: boolean;
}

/**
 * Deterministic Multi-Turn Developer Agent Session Cost Simulator.
 * Incorporates:
 * - Multi-turn context accumulation (initial repo context + tool/file read deltas)
 * - Provider prompt caching policies (automatic prefix caching vs explicit cache write)
 * - Context window compaction penalty & prefix cache invalidation when ctx exceeds 80% window
 * - Reasoning effort thinking token budget per turn
 */
export function calculateDeveloperAgentCost(params: {
  pricing: TokenPricing;
  provider: string;
  contextWindow: number | null | undefined;
  effortNormalized: string | null | undefined;
  isReasoningModel: boolean | null | undefined;
  profile?: DeveloperTaskProfile;
}): DeveloperAgentCostBreakdown | null {
  const {
    pricing,
    provider,
    contextWindow,
    effortNormalized,
    isReasoningModel,
    profile = "standard",
  } = params;

  if (
    pricing.inputPerMillion === null ||
    pricing.outputPerMillion === null ||
    !Number.isFinite(pricing.inputPerMillion) ||
    !Number.isFinite(pricing.outputPerMillion)
  ) {
    return null;
  }

  const spec = DEVELOPER_TASK_PROFILES[profile];
  const thinkingPerTurn = getThinkingTokensPerTurn(
    effortNormalized,
    isReasoningModel
  );

  const usableCtx = Math.max(
    8_000,
    Math.round((contextWindow ?? 128_000) * 0.8)
  );

  const hasCacheDiscount =
    pricing.cacheReadPerMillion !== null &&
    Number.isFinite(pricing.cacheReadPerMillion) &&
    pricing.cacheReadPerMillion < pricing.inputPerMillion;

  const prefixHitRate = hasCacheDiscount ? 0.9 : 0;
  const provLower = provider.trim().toLowerCase();
  const explicitCacheWrite =
    provLower.includes("anthropic") ||
    (pricing.cacheWritePerMillion !== null &&
      Number.isFinite(pricing.cacheWritePerMillion) &&
      pricing.cacheWritePerMillion > pricing.inputPerMillion);

  const effectiveCacheReadPrice =
    pricing.cacheReadPerMillion !== null &&
    Number.isFinite(pricing.cacheReadPerMillion)
      ? pricing.cacheReadPerMillion
      : pricing.inputPerMillion;

  const effectiveCacheWritePrice = explicitCacheWrite
    ? pricing.cacheWritePerMillion !== null &&
      Number.isFinite(pricing.cacheWritePerMillion)
      ? pricing.cacheWritePerMillion
      : pricing.inputPerMillion * 1.25
    : 0;

  let ctx = Math.min(spec.initialContextTokens, usableCtx);
  let sumContextTokens = ctx;
  let peakContextTokens = ctx;
  let uncachedInputTokens = 0;
  let cachedReadTokens = 0;
  let cacheWriteTokens = 0;
  let visibleOutputTokens = 0;
  let thinkingTokens = 0;
  let compactionCount = 0;

  // Turn 1: initial prompt + task context
  if (explicitCacheWrite) {
    cacheWriteTokens += ctx;
  } else {
    uncachedInputTokens += ctx;
  }
  visibleOutputTokens += spec.visibleOutputPerTurn;
  thinkingTokens += thinkingPerTurn;

  // Turns 2..N
  for (let t = 2; t <= spec.turns; t++) {
    const delta = spec.deltaTokensPerTurn + spec.visibleOutputPerTurn;
    if (ctx + delta > usableCtx) {
      // Context window exceeded: trigger compaction & prefix cache invalidation
      compactionCount += 1;
      const compactCached = Math.round(ctx * prefixHitRate);
      cachedReadTokens += compactCached;
      uncachedInputTokens += ctx - compactCached;
      visibleOutputTokens += 2_000;

      ctx = Math.round(usableCtx * 0.35);
      const nextCtx = Math.min(usableCtx, ctx + delta);
      if (explicitCacheWrite) {
        cacheWriteTokens += nextCtx;
      } else {
        uncachedInputTokens += nextCtx;
      }
      ctx = nextCtx;
    } else {
      const hitTokens = Math.round(ctx * prefixHitRate);
      cachedReadTokens += hitTokens;
      uncachedInputTokens += (ctx - hitTokens) + (explicitCacheWrite ? 0 : delta);
      if (explicitCacheWrite) {
        cacheWriteTokens += delta;
      }
      ctx += delta;
    }

    sumContextTokens += ctx;
    if (ctx > peakContextTokens) {
      peakContextTokens = ctx;
    }
    visibleOutputTokens += spec.visibleOutputPerTurn;
    thinkingTokens += thinkingPerTurn;
  }

  const avgContextTokens = Math.round(sumContextTokens / spec.turns);

  const outputTokens = visibleOutputTokens + thinkingTokens;
  const inputCostUsd = (uncachedInputTokens * pricing.inputPerMillion) / 1_000_000;
  const cacheReadCostUsd = (cachedReadTokens * effectiveCacheReadPrice) / 1_000_000;
  const cacheWriteCostUsd = (cacheWriteTokens * effectiveCacheWritePrice) / 1_000_000;
  const outputCostUsd = (outputTokens * pricing.outputPerMillion) / 1_000_000;
  const totalUsd =
    inputCostUsd + cacheReadCostUsd + cacheWriteCostUsd + outputCostUsd;

  const noCacheTotalInput =
    uncachedInputTokens + cachedReadTokens + cacheWriteTokens;
  const uncachedBaselineInputUsd =
    (noCacheTotalInput * pricing.inputPerMillion) / 1_000_000;
  const actualInputUsd = inputCostUsd + cacheReadCostUsd + cacheWriteCostUsd;
  const cacheSavingsUsd = Math.max(0, uncachedBaselineInputUsd - actualInputUsd);

  return {
    totalUsd,
    inputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    outputCostUsd,
    uncachedInputTokens,
    cachedReadTokens,
    cacheWriteTokens,
    outputTokens,
    thinkingTokens,
    compactionCount,
    cacheSavingsUsd,
    turns: spec.turns,
    avgContextTokens,
    peakContextTokens,
    profile,
    explicitCacheWrite,
    hasCacheDiscount,
  };
}
