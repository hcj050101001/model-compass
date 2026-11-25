import config from "@/config/agent-cost-config.json";
import type {
  AgentCostSummary,
  AgentUsageSummary,
  DataQualityLevel,
  DataQualitySummary,
  DataSourceType,
  TokenPricing,
} from "./types";

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

  const hasValidPricing =
    pricing.inputPerMillion !== null &&
    pricing.outputPerMillion !== null &&
    Number.isFinite(pricing.inputPerMillion) &&
    Number.isFinite(pricing.outputPerMillion);

  const hasRealSessions =
    usage.sample_count > 0 &&
    (cost.p50 !== null || cost.effective_cost !== null || cost.rasc !== null);

  const isStale = updatedAt
    ? Date.now() - Date.parse(updatedAt) > windowDays * 24 * 60 * 60 * 1000
    : false;

  if (hasRealSessions) {
    const lowSampleWarning =
      usage.sample_count < minSamples ||
      usage.independent_user_count < minIndependentUsers;

    const level: DataQualityLevel =
      allSessionsBilled || hasActualBilledSessions ? "A" : "B";
    const sourceType: DataSourceType =
      level === "A" ? "measured_billed" : "measured_token_pricing";

    return {
      level,
      source_type: sourceType,
      sources,
      updated_at: updatedAt,
      is_stale: isStale,
      effort_token_diff_known: effortTokenDiffKnown,
      low_sample_warning: lowSampleWarning,
      window_days: windowDays,
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
  };
}
