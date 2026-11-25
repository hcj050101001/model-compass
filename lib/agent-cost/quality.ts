import config from "@/config/agent-cost-config.json";
import type {
  AgentCostSummary,
  AgentUsageSummary,
  DataQualityLevel,
  DataQualitySummary,
  DataSourceType,
  TokenPricing,
} from "./types";

export const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000; // 1 day (design sec.2.4)
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rolling sample expiry (Package C, design sec.2.4 / C-3): a measured group
 * stays reusable until earliestSample + windowDays (UTC arithmetic on epoch
 * ms). Missing or invalid sample timestamps fail closed; timestamps more
 * than 1 day in the future (relative to the explicit `now`) are invalid.
 */
export function getSampleWindowExpiry(
  usage: Pick<AgentUsageSummary, "time_range_start">,
  windowDays: number
): number | null {
  if (!usage.time_range_start) return null;
  const start = Date.parse(usage.time_range_start);
  if (!Number.isFinite(start)) return null;
  return start + windowDays * DAY_MS;
}

export function classifyDataQuality(params: {
  usage: AgentUsageSummary;
  cost: AgentCostSummary;
  pricing: TokenPricing;
  hasActualBilledSessions: boolean;
  allSessionsBilled: boolean;
  sources: string[];
  updatedAt: string | null;
  effortTokenDiffKnown?: boolean;
  minSamples?: number;
  minIndependentUsers?: number;
  windowDays?: number;
  /** Explicit evaluation instant (injectable clock; defaults to now). */
  now?: Date | string | number;
  /** Mixed-source breakdown (Package C): verified billed vs token-priced. */
  billedSampleCount?: number;
  tokenPricedSampleCount?: number;
  billedAmountUsd?: number | null;
  tokenPricedAmountUsd?: number | null;
  /** Verified (declared/template) effort tier; kept separate from observed tokens. */
  verifiedEffort?: string | null;
}): DataQualitySummary {
  const {
    usage,
    cost,
    pricing,
    hasActualBilledSessions,
    allSessionsBilled,
    sources,
    updatedAt,
    effortTokenDiffKnown = false,
    minSamples = config.qualityThresholds.minSamples,
    minIndependentUsers = config.qualityThresholds.minIndependentUsers,
    windowDays = config.windowDays,
  } = params;

  const nowMs =
    params.now === undefined
      ? Date.now()
      : params.now instanceof Date
        ? params.now.getTime()
        : typeof params.now === "number"
          ? params.now
          : Date.parse(params.now);

  const hasValidPricing =
    pricing.inputPerMillion !== null &&
    pricing.outputPerMillion !== null &&
    Number.isFinite(pricing.inputPerMillion) &&
    Number.isFinite(pricing.outputPerMillion) &&
    pricing.inputPerMillion >= 0 &&
    pricing.outputPerMillion >= 0;

  const hasRealSessions =
    usage.sample_count > 0 &&
    (cost.p50 !== null || cost.effective_cost !== null || cost.rasc !== null);

  const observedTokens = {
    avg_input: usage.avg_input_tokens,
    avg_output: usage.avg_output_tokens,
    avg_reasoning: usage.avg_reasoning_tokens,
  };
  const breakdown = {
    billed_sample_count: params.billedSampleCount ?? (allSessionsBilled ? usage.sample_count : 0),
    token_priced_sample_count:
      params.tokenPricedSampleCount ?? (allSessionsBilled ? 0 : usage.sample_count),
    billed_amount_usd: params.billedAmountUsd ?? null,
    token_priced_amount_usd: params.tokenPricedAmountUsd ?? null,
    verified_effort: params.verifiedEffort ?? null,
    observed_tokens: observedTokens,
  };

  const isStale = updatedAt
    ? nowMs - Date.parse(updatedAt) > windowDays * DAY_MS
    : false;

  if (hasRealSessions) {
    const startMs = usage.time_range_start ? Date.parse(usage.time_range_start) : NaN;
    const endMs = usage.time_range_end ? Date.parse(usage.time_range_end) : NaN;
    const expiryMs = getSampleWindowExpiry(usage, windowDays);
    const timestampsValid =
      Number.isFinite(startMs) &&
      Number.isFinite(endMs) &&
      startMs <= endMs + FUTURE_TOLERANCE_MS &&
      endMs <= nowMs + FUTURE_TOLERANCE_MS &&
      startMs <= nowMs + FUTURE_TOLERANCE_MS;
    const expired = expiryMs === null || nowMs > expiryMs;
    const meetsThresholds =
      usage.sample_count >= minSamples &&
      usage.independent_user_count >= minIndependentUsers;
    const lowSampleWarning = !meetsThresholds;

    if (timestampsValid && !expired && meetsThresholds) {
      const level: DataQualityLevel = allSessionsBilled
        ? "A"
        : "B";
      const sourceType: DataSourceType = allSessionsBilled
        ? "measured_billed"
        : hasActualBilledSessions
          ? "measured_mixed"
          : "measured_token_pricing";

      return {
        level,
        source_type: sourceType,
        sources,
        updated_at: updatedAt,
        is_stale: isStale,
        effort_token_diff_known: effortTokenDiffKnown,
        low_sample_warning: false,
        window_days: windowDays,
        ...breakdown,
        measured_eligible_rasc: cost.rasc !== null,
        measured_eligible_p50: cost.p50 !== null,
        sample_window_expires_at:
          expiryMs !== null ? new Date(expiryMs).toISOString() : null,
      };
    }

    // Fail closed: insufficient samples/users, expired rolling window, or
    // missing/invalid timestamps keep the evidence inspectable but the group
    // is NOT measured-eligible; it falls back to estimated/unavailable.
    return {
      ...(hasValidPricing && cost.estimated_cost !== null
        ? {
            level: "C" as DataQualityLevel,
            source_type: "estimated" as DataSourceType,
          }
        : {
            level: "D" as DataQualityLevel,
            source_type: "unavailable" as DataSourceType,
          }),
      sources,
      updated_at: updatedAt,
      is_stale: isStale || expired,
      effort_token_diff_known: effortTokenDiffKnown,
      low_sample_warning: lowSampleWarning,
      window_days: windowDays,
      ...breakdown,
      measured_eligible_rasc: false,
      measured_eligible_p50: false,
      sample_window_expires_at:
        expiryMs !== null ? new Date(expiryMs).toISOString() : null,
    };
  }

  if (hasValidPricing && cost.estimated_cost !== null) {
    return {
      level: "C",
      source_type: "estimated",
      sources,
      updated_at: updatedAt,
      is_stale: isStale,
      effort_token_diff_known: false,
      low_sample_warning: false,
      window_days: windowDays,
      ...breakdown,
      measured_eligible_rasc: false,
      measured_eligible_p50: false,
      sample_window_expires_at: null,
    };
  }

  return {
    level: "D",
    source_type: "unavailable",
    sources,
    updated_at: updatedAt,
    is_stale: isStale,
    effort_token_diff_known: false,
    low_sample_warning: false,
    window_days: windowDays,
    ...breakdown,
    measured_eligible_rasc: false,
    measured_eligible_p50: false,
    sample_window_expires_at: null,
  };
}
