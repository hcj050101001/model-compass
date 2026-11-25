import { calculateSessionCost } from "./billing-adapters";
import { sha256Hex } from "./sha256";
import type {
  AgentCostSummary,
  AgentScenario,
  AgentUsageSummary,
  RawAgentSessionRecord,
  ScenarioStatistic,
  ScenarioWeights,
  TokenPricing,
} from "./types";

export const DEFAULT_SCENARIO_WEIGHTS: ScenarioWeights = {
  simple_coding: 0.15,
  bug_fix: 0.25,
  multi_file_engineering: 0.2,
  large_repo_understanding: 0.15,
  search_research: 0.15,
  general_tool_use: 0.1,
};

export function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * frac;
}

export function normalizeScenarioWeights(
  weights: Partial<ScenarioWeights>
): ScenarioWeights {
  const keys = Object.keys(DEFAULT_SCENARIO_WEIGHTS) as AgentScenario[];
  const merged: ScenarioWeights = { ...DEFAULT_SCENARIO_WEIGHTS };
  for (const k of keys) {
    const val = weights[k];
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      merged[k] = val;
    }
  }
  const sum = keys.reduce((acc, k) => acc + merged[k], 0);
  if (sum <= 0) return { ...DEFAULT_SCENARIO_WEIGHTS };
  const normalized = {} as ScenarioWeights;
  for (const k of keys) {
    normalized[k] = merged[k] / sum;
  }
  return normalized;
}

export interface RascComputationResult {
  usage: AgentUsageSummary;
  cost: Omit<AgentCostSummary, "estimated_cost">;
  hasActualBilledSessions: boolean;
  allSessionsBilled: boolean;
  sources: string[];
  /** Package C breakdown: verified-billed vs token-priced portions. */
  billedSampleCount: number;
  tokenPricedSampleCount: number;
  billedAmountUsd: number | null;
  tokenPricedAmountUsd: number | null;
  /** Stable digest of the exact sample set (order-insensitive). */
  sampleSetDigest: string;
}

/**
 * Digest of the participating sample set: two sets with identical aggregate
 * statistics but different samples produce different digests, and the same
 * set in any order produces the same digest (Package C hash evidence).
 */
export function computeSampleSetDigest(
  samples: Array<{
    sessionId: string;
    timestamp: string;
    succeeded: boolean;
    scenario: string;
    costUsd: number;
  }>
): string {
  const keys = samples
    .map((s) =>
      [s.sessionId, s.timestamp, s.succeeded ? "1" : "0", s.scenario, s.costUsd.toFixed(8)].join("|")
    )
    .sort();
  return sha256Hex(keys.join("\n"));
}

export function computeRealAgentStatsAndRasc(params: {
  sessions: RawAgentSessionRecord[];
  pricing: TokenPricing;
  scenarioWeights?: Partial<ScenarioWeights>;
  minSamplesPerScenario?: number;
  includeExtraToolCost?: boolean;
}): RascComputationResult {
  const {
    sessions,
    pricing,
    scenarioWeights = DEFAULT_SCENARIO_WEIGHTS,
    minSamplesPerScenario = 5,
    includeExtraToolCost = false,
  } = params;

  const emptyUsage: AgentUsageSummary = {
    sample_count: 0,
    independent_user_count: 0,
    avg_input_tokens: null,
    avg_output_tokens: null,
    avg_reasoning_tokens: null,
    avg_cache_hit_rate: null,
    avg_api_calls: null,
    success_rate: null,
    time_range_start: null,
    time_range_end: null,
    scenario_statistics: [],
  };

  const emptyCost: Omit<AgentCostSummary, "estimated_cost"> = {
    p25: null,
    p50: null,
    p75: null,
    p90: null,
    mean: null,
    effective_cost: null,
    rasc: null,
    extra_tool_cost_mean: null,
  };

  if (sessions.length === 0) {
    return {
      usage: emptyUsage,
      cost: emptyCost,
      hasActualBilledSessions: false,
      allSessionsBilled: false,
      sources: [],
      billedSampleCount: 0,
      tokenPricedSampleCount: 0,
      billedAmountUsd: null,
      tokenPricedAmountUsd: null,
      sampleSetDigest: computeSampleSetDigest([]),
    };
  }

  const billedSessions: Array<{
    session: RawAgentSessionRecord;
    costUsd: number;
    extraToolCostUsd: number;
    isActualBilled: boolean;
  }> = [];

  for (const s of sessions) {
    const billing = calculateSessionCost(s, pricing, { includeExtraToolCost });
    if (billing) {
      billedSessions.push({
        session: s,
        costUsd: billing.sessionCostUsd,
        extraToolCostUsd: billing.extraToolCostUsd,
        isActualBilled: billing.isActualBilled,
      });
    }
  }

  if (billedSessions.length === 0) {
    return {
      usage: emptyUsage,
      cost: emptyCost,
      hasActualBilledSessions: false,
      allSessionsBilled: false,
      sources: [],
      billedSampleCount: 0,
      tokenPricedSampleCount: 0,
      billedAmountUsd: null,
      tokenPricedAmountUsd: null,
      sampleSetDigest: computeSampleSetDigest([]),
    };
  }

  const costs = billedSessions.map((b) => b.costUsd).sort((a, b) => a - b);
  const totalCostAllAttempts = billedSessions.reduce((acc, b) => acc + b.costUsd, 0);
  const totalToolCost = billedSessions.reduce((acc, b) => acc + b.extraToolCostUsd, 0);
  const successfulCount = billedSessions.filter((b) => b.session.succeeded).length;

  const users = new Set<string>();
  const sources = new Set<string>();
  let totalInput = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let reasoningSamples = 0;
  let totalCached = 0;
  let totalCalls = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const { session } of billedSessions) {
    if (session.userIdHash) users.add(session.userIdHash);
    sources.add(session.source);
    const ts = Date.parse(session.timestamp);
    if (Number.isFinite(ts)) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    totalCalls += session.calls.length;
    for (const c of session.calls) {
      totalInput += c.uncachedInputTokens + c.cachedInputTokens;
      totalCached += c.cachedInputTokens;
      totalOutput += c.billableOutputTokens;
      if (typeof c.reasoningTokens === "number") {
        totalReasoning += c.reasoningTokens;
        reasoningSamples += 1;
      }
    }
  }

  const n = billedSessions.length;
  const effectiveCost =
    successfulCount > 0 ? totalCostAllAttempts / successfulCount : null;

  // Scenario-level breakdown
  const byScenario = new Map<AgentScenario, typeof billedSessions>();
  for (const item of billedSessions) {
    const list = byScenario.get(item.session.scenario) ?? [];
    list.push(item);
    byScenario.set(item.session.scenario, list);
  }

  const scenarioKeys = Object.keys(DEFAULT_SCENARIO_WEIGHTS) as AgentScenario[];
  const scenarioStatistics: ScenarioStatistic[] = [];
  const scenarioEffectiveMap = new Map<AgentScenario, { effective: number | null; sufficient: boolean }>();

  for (const scenario of scenarioKeys) {
    const list = byScenario.get(scenario) ?? [];
    if (list.length === 0) continue;
    const sCosts = list.map((x) => x.costUsd).sort((a, b) => a - b);
    const sTotalCost = list.reduce((acc, x) => acc + x.costUsd, 0);
    const sSuccess = list.filter((x) => x.session.succeeded).length;
    const sEff = sSuccess > 0 ? sTotalCost / sSuccess : null;
    const sufficient = list.length >= minSamplesPerScenario && sEff !== null;

    scenarioStatistics.push({
      scenario,
      sample_count: list.length,
      success_count: sSuccess,
      success_rate: sSuccess / list.length,
      mean_cost: sTotalCost / list.length,
      p50_cost: percentile(sCosts, 0.5),
      effective_cost: sEff,
      sufficient,
    });
    scenarioEffectiveMap.set(scenario, { effective: sEff, sufficient });
  }

  // Standardized RASC: never impute missing scenarios with 0 or other models' data
  const normWeights = normalizeScenarioWeights(scenarioWeights);
  let rasc: number | null = 0;
  for (const scenario of scenarioKeys) {
    const w = normWeights[scenario];
    if (w <= 0) continue;
    const stat = scenarioEffectiveMap.get(scenario);
    if (!stat || !stat.sufficient || stat.effective === null) {
      rasc = null;
      break;
    }
    rasc += w * stat.effective;
  }

  const hasActualBilledSessions = billedSessions.some((b) => b.isActualBilled);
  const allSessionsBilled = billedSessions.every((b) => b.isActualBilled);

  return {
    usage: {
      sample_count: n,
      independent_user_count: users.size,
      avg_input_tokens: totalInput / n,
      avg_output_tokens: totalOutput / n,
      avg_reasoning_tokens: reasoningSamples > 0 ? totalReasoning / n : null,
      avg_cache_hit_rate: totalInput > 0 ? totalCached / totalInput : null,
      avg_api_calls: totalCalls / n,
      success_rate: successfulCount / n,
      time_range_start: Number.isFinite(minTs) ? new Date(minTs).toISOString() : null,
      time_range_end: Number.isFinite(maxTs) ? new Date(maxTs).toISOString() : null,
      scenario_statistics: scenarioStatistics,
    },
    cost: {
      p25: percentile(costs, 0.25),
      p50: percentile(costs, 0.5),
      p75: percentile(costs, 0.75),
      p90: percentile(costs, 0.9),
      mean: totalCostAllAttempts / n,
      effective_cost: effectiveCost,
      rasc,
      extra_tool_cost_mean: totalToolCost / n,
    },
    hasActualBilledSessions,
    allSessionsBilled,
    sources: Array.from(sources),
    billedSampleCount: billedSessions.filter((b) => b.isActualBilled).length,
    tokenPricedSampleCount: billedSessions.filter((b) => !b.isActualBilled).length,
    billedAmountUsd: billedSessions.some((b) => b.isActualBilled)
      ? billedSessions.filter((b) => b.isActualBilled).reduce((acc, b) => acc + b.costUsd, 0)
      : null,
    tokenPricedAmountUsd: billedSessions.some((b) => !b.isActualBilled)
      ? billedSessions.filter((b) => !b.isActualBilled).reduce((acc, b) => acc + b.costUsd, 0)
      : null,
    sampleSetDigest: computeSampleSetDigest(
      billedSessions.map((b) => ({
        sessionId: b.session.sessionId,
        timestamp: b.session.timestamp,
        succeeded: b.session.succeeded,
        scenario: b.session.scenario,
        costUsd: b.costUsd,
      }))
    ),
  };
}
