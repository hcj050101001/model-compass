import type { TokenPricing } from "./types";

/**
 * Multi-turn simulation template version (Package D, design sec.2.5 / D-1).
 * The legacy single-pass template in eac.ts is the implicit v1; this
 * multi-turn template is "mt-v2". The version is persisted per snapshot
 * (data_snapshots.template_version) and surfaced in API/export payloads.
 * Snapshots without a version carry legacy derived values and must be
 * labelled as legacy fallback (LEGACY_TEMPLATE_VERSION).
 */
export const MULTI_TURN_TEMPLATE_VERSION = "mt-v2";
export const LEGACY_TEMPLATE_VERSION = "legacy-v1";

/** Context window assumed when a variant reports no window (128K fallback). */
export const ASSUMED_CONTEXT_WINDOW = 128_000;

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
  // Explicit numeric budgets normalized as "N Tokens" (e.g. "4096 Tokens",
  // "32000 Tokens") are the per-turn thinking budget itself (design sec.2.5
  // D-2). 0 is a valid budget. A digit string outside the safe-integer range
  // is not a trustworthy budget: return NaN so the simulator refuses to
  // produce a rankable amount instead of silently using the fallback table.
  const numericBudget = norm.match(/^(\d+) tokens$/);
  if (numericBudget) {
    const value = Number(numericBudget[1]);
    return Number.isSafeInteger(value) ? value : Number.NaN;
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
  /** Multi-turn template version that produced this breakdown. */
  templateVersion: string;
  /** True when no window was reported and the 128K assumption was used. */
  contextWindowAssumed: boolean;
  /** True when an invalid cache-read price was treated as missing. */
  cacheReadPriceFallback: boolean;
  /** True when an explicit cache write had to use the 1.25x input fallback. */
  cacheWritePriceFallback: boolean;
  /** True when the effort label was not a known/numeric tier and the
   *  fallback thinking budget from the tier table was used. */
  thinkingBudgetFallback: boolean;
}

export type DeveloperCostFailureReason =
  | "missing_price"
  | "invalid_price"
  | "invalid_context_window"
  | "context_window_too_small"
  | "invalid_thinking_budget"
  | "numeric_overflow";

export interface DeveloperCostResult {
  cost: DeveloperAgentCostBreakdown | null;
  reason: DeveloperCostFailureReason | null;
}

/**
 * Deterministic Multi-Turn Developer Agent Session Cost Simulator.
 * Incorporates:
 * - Multi-turn context accumulation (initial repo context + tool/file read deltas)
 * - Provider prompt caching policies (automatic prefix caching vs explicit cache write)
 * - Context window compaction penalty & prefix cache invalidation when ctx exceeds 80% window
 * - Reasoning effort thinking token budget per turn
 */
function isValidPrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/**
 * Structured variant of calculateDeveloperAgentCost: on failure it reports
 * WHY no rankable amount exists (design sec.2.5 D-2) instead of a bare null.
 * Boundary rules (all pinned by tests/agent-cost.test.ts):
 * - Required input/output prices must be finite and non-negative; 0 is a
 *   legal price, negative or non-finite prices are rejected.
 * - Invalid cache prices are treated as missing (flagged as fallbacks);
 *   a valid 0 cache price is kept.
 * - Usable window = floor(80% of the physical window). Only an unreported
 *   window falls back to the 128K assumption; a reported window must be a
 *   positive safe integer or the variant is not estimable.
 * - A normal turn reserves visible output + thinking budget; a compaction
 *   turn reserves only the 2,000-token summary. If the initial context or
 *   the post-compaction increment does not fit, the variant is not
 *   estimable (no silent truncation, no rankable amount).
 * - Compaction retains round(35% of the usable pre-compaction window) of
 *   context; this is the reading that reproduces the research report's
 *   standard High worked example exactly (739,840 / 64,700 / $0.99864).
 */
export function calculateDeveloperAgentCostDetailed(params: {
  pricing: TokenPricing;
  provider: string;
  contextWindow: number | null | undefined;
  effortNormalized: string | null | undefined;
  isReasoningModel: boolean | null | undefined;
  profile?: DeveloperTaskProfile;
}): DeveloperCostResult {
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
    pricing.outputPerMillion === null
  ) {
    return { cost: null, reason: "missing_price" };
  }
  if (
    !Number.isFinite(pricing.inputPerMillion) ||
    !Number.isFinite(pricing.outputPerMillion) ||
    pricing.inputPerMillion < 0 ||
    pricing.outputPerMillion < 0
  ) {
    return { cost: null, reason: "invalid_price" };
  }
  const inputPrice = pricing.inputPerMillion;
  const outputPrice = pricing.outputPerMillion;

  const spec = DEVELOPER_TASK_PROFILES[profile];
  const thinkingPerTurn = getThinkingTokensPerTurn(
    effortNormalized,
    isReasoningModel
  );
  if (!Number.isFinite(thinkingPerTurn) || thinkingPerTurn < 0) {
    return { cost: null, reason: "invalid_thinking_budget" };
  }
  const normEffort = (effortNormalized ?? "").trim().toLowerCase();
  const thinkingBudgetFallback =
    normEffort !== "" &&
    !/^\d+ tokens$/.test(normEffort) &&
    ![
      "non-thinking",
      "standard",
      "none",
      "minimal",
      "low",
      "medium",
      "adaptive",
      "high",
      "very high",
      "xhigh",
      "max",
    ].some((k) => normEffort.startsWith(k));

  // Window: only an unreported window uses the 128K assumption.
  const contextWindowAssumed =
    contextWindow === null || contextWindow === undefined;
  const physicalWindow = contextWindowAssumed
    ? ASSUMED_CONTEXT_WINDOW
    : contextWindow;
  if (
    !Number.isSafeInteger(physicalWindow) ||
    (physicalWindow as number) <= 0
  ) {
    return { cost: null, reason: "invalid_context_window" };
  }
  const windowTokens = physicalWindow as number;
  const usableCtx = Math.floor(windowTokens * 0.8);
  // Per-request input caps: the 80% usable window further reduced by the
  // output reserve of the request itself, never above the physical window.
  const normalTurnCap = Math.min(
    usableCtx,
    windowTokens - (spec.visibleOutputPerTurn + thinkingPerTurn)
  );
  const compactionCap = Math.min(usableCtx, windowTokens - 2_000);

  // Cache prices: invalid values are treated as missing and flagged.
  const cacheReadPriceFallback =
    pricing.cacheReadPerMillion !== null &&
    !isValidPrice(pricing.cacheReadPerMillion);
  const cacheWritePriceInvalid =
    pricing.cacheWritePerMillion !== null &&
    !isValidPrice(pricing.cacheWritePerMillion);
  const validCacheReadPrice = isValidPrice(pricing.cacheReadPerMillion)
    ? pricing.cacheReadPerMillion
    : null;
  const validCacheWritePrice = isValidPrice(pricing.cacheWritePerMillion)
    ? pricing.cacheWritePerMillion
    : null;

  const hasCacheDiscount =
    validCacheReadPrice !== null && validCacheReadPrice < inputPrice;

  const prefixHitRate = hasCacheDiscount ? 0.9 : 0;
  const provLower = provider.trim().toLowerCase();
  const explicitCacheWrite =
    provLower.includes("anthropic") ||
    (validCacheWritePrice !== null && validCacheWritePrice > inputPrice);

  const effectiveCacheReadPrice = validCacheReadPrice ?? inputPrice;

  const cacheWritePriceFallback =
    explicitCacheWrite && validCacheWritePrice === null;
  const effectiveCacheWritePrice = explicitCacheWrite
    ? validCacheWritePrice ?? inputPrice * 1.25
    : 0;
  void cacheWritePriceInvalid;

  if (spec.initialContextTokens > normalTurnCap) {
    return { cost: null, reason: "context_window_too_small" };
  }

  let ctx = spec.initialContextTokens;
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
    if (ctx + delta > normalTurnCap) {
      // Context window exceeded: trigger compaction & prefix cache invalidation.
      // The compaction request itself must fit with only the summary reserved.
      if (ctx > compactionCap) {
        return { cost: null, reason: "context_window_too_small" };
      }
      compactionCount += 1;
      const compactCached = Math.round(ctx * prefixHitRate);
      cachedReadTokens += compactCached;
      uncachedInputTokens += ctx - compactCached;
      visibleOutputTokens += 2_000;

      const retained = Math.round(usableCtx * 0.35);
      const nextCtx = retained + delta;
      if (nextCtx > normalTurnCap) {
        return { cost: null, reason: "context_window_too_small" };
      }
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
  const inputCostUsd = (uncachedInputTokens * inputPrice) / 1_000_000;
  const cacheReadCostUsd = (cachedReadTokens * effectiveCacheReadPrice) / 1_000_000;
  const cacheWriteCostUsd = (cacheWriteTokens * effectiveCacheWritePrice) / 1_000_000;
  const outputCostUsd = (outputTokens * outputPrice) / 1_000_000;
  const totalUsd =
    inputCostUsd + cacheReadCostUsd + cacheWriteCostUsd + outputCostUsd;

  const noCacheTotalInput =
    uncachedInputTokens + cachedReadTokens + cacheWriteTokens;
  const uncachedBaselineInputUsd =
    (noCacheTotalInput * inputPrice) / 1_000_000;
  const actualInputUsd = inputCostUsd + cacheReadCostUsd + cacheWriteCostUsd;
  const cacheSavingsUsd = Math.max(0, uncachedBaselineInputUsd - actualInputUsd);

  const tokenCounts = [
    uncachedInputTokens,
    cachedReadTokens,
    cacheWriteTokens,
    outputTokens,
    thinkingTokens,
  ];
  const amounts = [
    inputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    outputCostUsd,
    totalUsd,
    cacheSavingsUsd,
  ];
  if (
    tokenCounts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    amounts.some((n) => !Number.isFinite(n) || n < 0)
  ) {
    return { cost: null, reason: "numeric_overflow" };
  }

  return {
    cost: {
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
      templateVersion: MULTI_TURN_TEMPLATE_VERSION,
      contextWindowAssumed,
      cacheReadPriceFallback,
      cacheWritePriceFallback,
      thinkingBudgetFallback,
    },
    reason: null,
  };
}

export function calculateDeveloperAgentCost(params: {
  pricing: TokenPricing;
  provider: string;
  contextWindow: number | null | undefined;
  effortNormalized: string | null | undefined;
  isReasoningModel: boolean | null | undefined;
  profile?: DeveloperTaskProfile;
}): DeveloperAgentCostBreakdown | null {
  return calculateDeveloperAgentCostDetailed(params).cost;
}
