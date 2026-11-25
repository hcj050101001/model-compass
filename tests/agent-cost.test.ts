import { describe, expect, it } from "vitest";
import {
  calculateCallCost,
  calculateSessionCost,
} from "@/lib/agent-cost/billing-adapters";
import { cleanAndDeduplicateSessions } from "@/lib/agent-cost/cleaning";
import { calculateEAC, getPresetAgentParams } from "@/lib/agent-cost/eac";
import { classifyDataQuality } from "@/lib/agent-cost/quality";
import { computeRealAgentStatsAndRasc } from "@/lib/agent-cost/rasc";
import type { RawAgentSessionRecord, TokenPricing } from "@/lib/agent-cost/types";
import {
  calculateDeveloperAgentCost,
  calculateDeveloperAgentCostDetailed,
  classifyTaskScale,
  MULTI_TURN_TEMPLATE_VERSION,
} from "@/lib/agent-cost/developer-cost";
import { getDeveloperAgentCost, getXAxisValue } from "@/lib/utils/format";
import { compareVariants, toTargetPoints } from "@/lib/analytics/targets";
import type { MeasurementRow } from "@/lib/analytics/types";
import { calculateParetoFrontier } from "@/lib/analytics/pareto";

const PRICING: TokenPricing = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
  currency: "USD",
};

describe("Agent Cost Engine (RASC & EAC)", () => {
  it("computes call and session cost without double-counting reasoning tokens", () => {
    const included = calculateCallCost(
      {
        uncachedInputTokens: 100_000,
        cachedInputTokens: 200_000,
        cacheWriteTokens: 50_000,
        billableOutputTokens: 20_000,
        reasoningTokens: 12_000,
        reasoningIncludedInOutput: true,
      },
      PRICING,
      "anthropic"
    );
    // 0.1*3 + 0.2*0.3 + 0.05*3.75 + 0.02*15 = 0.3 + 0.06 + 0.1875 + 0.3 = 0.8475
    expect(included?.costUsd).toBeCloseTo(0.8475, 6);

    const separate = calculateCallCost(
      {
        uncachedInputTokens: 100_000,
        cachedInputTokens: 200_000,
        cacheWriteTokens: 50_000,
        billableOutputTokens: 8_000,
        reasoningTokens: 12_000,
        reasoningIncludedInOutput: false,
      },
      PRICING,
      "anthropic"
    );
    expect(separate?.costUsd).toBeCloseTo(0.8475, 6);
  });

  it("prefers actualBilledUsd, handles extraToolCost toggle, and rejects subscription plans", () => {
    const baseSession: RawAgentSessionRecord = {
      sessionId: "sess-1",
      userIdHash: "u1",
      modelId: "claude-sonnet",
      provider: "anthropic",
      scenario: "bug_fix",
      complexity: "medium",
      succeeded: true,
      actualBilledUsd: 1.25,
      extraToolCostUsd: 0.15,
      calls: [
        {
          uncachedInputTokens: 1000,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          billableOutputTokens: 500,
        },
      ],
      timestamp: new Date().toISOString(),
      source: "otel:test",
    };

    const withoutTool = calculateSessionCost(baseSession, PRICING, {
      includeExtraToolCost: false,
    });
    expect(withoutTool?.sessionCostUsd).toBeCloseTo(1.25);
    expect(withoutTool?.isActualBilled).toBe(true);

    const withTool = calculateSessionCost(baseSession, PRICING, {
      includeExtraToolCost: true,
    });
    expect(withTool?.sessionCostUsd).toBeCloseTo(1.4);

    const sub = calculateSessionCost(
      { ...baseSession, billingMode: "subscription" },
      PRICING
    );
    expect(sub).toBeNull();
  });

  it("computes EffectiveCost including failed attempts and returns null RASC when any scenario is missing", () => {
    const now = new Date().toISOString();
    const sessions: RawAgentSessionRecord[] = [
      {
        sessionId: "s1",
        userIdHash: "u1",
        modelId: "m1",
        provider: "openai",
        scenario: "bug_fix",
        complexity: "medium",
        succeeded: true,
        actualBilledUsd: 1.0,
        calls: [
          {
            uncachedInputTokens: 1000,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            billableOutputTokens: 500,
          },
        ],
        timestamp: now,
        source: "user-upload:test",
      },
      {
        sessionId: "s2",
        userIdHash: "u2",
        modelId: "m1",
        provider: "openai",
        scenario: "bug_fix",
        complexity: "medium",
        succeeded: false,
        actualBilledUsd: 2.0,
        calls: [
          {
            uncachedInputTokens: 2000,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            billableOutputTokens: 800,
          },
        ],
        timestamp: now,
        source: "user-upload:test",
      },
    ];

    const res = computeRealAgentStatsAndRasc({
      sessions,
      pricing: PRICING,
      minSamplesPerScenario: 1,
    });
    // Total cost = 3.0, 1 success -> effective_cost = 3.0
    expect(res.cost.effective_cost).toBeCloseTo(3.0);
    expect(res.cost.mean).toBeCloseTo(1.5);
    expect(res.usage.success_rate).toBeCloseTo(0.5);
    // Other 5 scenarios are missing -> RASC must be null (never imputed with 0)
    expect(res.cost.rasc).toBeNull();
  });

  it("computes EAC presets without multiplying cumulative tokens by apiCalls", () => {
    const medium = getPresetAgentParams("medium");
    const eac = calculateEAC(PRICING, medium);
    // totalInput=120k, hitRate=0.6 -> C=72k, U=48k, W=15k, O=12k
    // (48k*3 + 72k*0.3 + 15k*3.75 + 12k*15) / 1M = (144000 + 21600 + 56250 + 180000)/1M = 0.40185
    expect(eac?.estimatedCostUsd).toBeCloseTo(0.40185, 6);

    const missingPrice = calculateEAC(
      {
        inputPerMillion: null,
        outputPerMillion: 15,
        cacheReadPerMillion: null,
        cacheWritePerMillion: null,
        currency: "USD",
      },
      medium
    );
    expect(missingPrice).toBeNull();
  });

  it("rejects PII/API keys, deduplicates sessions, and classifies A/B/C/D quality", () => {
    const now = new Date().toISOString();
    const cleaned = cleanAndDeduplicateSessions([
      {
        sessionId: "ok-1",
        modelId: "m1",
        provider: "openai",
        scenario: "bug_fix",
        complexity: "light",
        succeeded: true,
        calls: [
          {
            uncachedInputTokens: 1000,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            billableOutputTokens: 200,
          },
        ],
        timestamp: now,
        source: "otel:local",
      },
      {
        sessionId: "ok-1", // duplicate
        modelId: "m1",
        provider: "openai",
        scenario: "bug_fix",
        complexity: "light",
        succeeded: true,
        calls: [
          {
            uncachedInputTokens: 1000,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            billableOutputTokens: 200,
          },
        ],
        timestamp: now,
        source: "otel:local",
      },
      {
        sessionId: "bad-key",
        api_key: "sk-1234567890abcdef123456",
        modelId: "m1",
        provider: "openai",
        scenario: "bug_fix",
        complexity: "light",
        succeeded: true,
        calls: [
          {
            uncachedInputTokens: 1000,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            billableOutputTokens: 200,
          },
        ],
        timestamp: now,
        source: "otel:local",
      },
    ]);

    expect(cleaned.validSessions).toHaveLength(1);
    expect(cleaned.duplicateCount).toBe(1);
    expect(cleaned.rejectedCount).toBe(1);

    const qC = classifyDataQuality({
      usage: {
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
      },
      cost: {
        p25: null,
        p50: null,
        p75: null,
        p90: null,
        mean: null,
        effective_cost: null,
        rasc: null,
        estimated_cost: 0.4,
        extra_tool_cost_mean: null,
      },
      pricing: PRICING,
      hasActualBilledSessions: false,
      allSessionsBilled: false,
      sources: ["litellm"],
      updatedAt: now,
    });
    expect(qC.level).toBe("C");
    expect(qC.source_type).toBe("estimated");
  });

  it("enforces strict Pareto isolation between Grade A/B and Grade C", () => {
    expect(() =>
      calculateParetoFrontier([
        { id: "a", cost: 0.5, score: 60, indexVersion: "5", qualityLevel: "B" },
        { id: "b", cost: 0.4, score: 58, indexVersion: "5", qualityLevel: "C" },
      ])
    ).toThrow(/Cannot mix real measured costs/);
  });

  it("simulates multi-turn Developer Agent cost with effort scaling, caching policy, and context compaction", () => {
    const low = calculateDeveloperAgentCost({
      pricing: PRICING,
      provider: "anthropic",
      contextWindow: 1_000_000,
      effortNormalized: "Low",
      isReasoningModel: true,
      profile: "standard",
    });
    const high = calculateDeveloperAgentCost({
      pricing: PRICING,
      provider: "anthropic",
      contextWindow: 1_000_000,
      effortNormalized: "High",
      isReasoningModel: true,
      profile: "standard",
    });
    const smallCtx = calculateDeveloperAgentCost({
      pricing: PRICING,
      provider: "anthropic",
      contextWindow: 64_000,
      effortNormalized: "High",
      isReasoningModel: true,
      profile: "standard",
    });

    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(smallCtx).not.toBeNull();
    // Effort tiers separate cleanly (no vertical lines!)
    expect(high!.totalUsd).toBeGreaterThan(low!.totalUsd);
    // 1M context window has 0 compactions and significant cache savings
    expect(high!.compactionCount).toBe(0);
    expect(high!.cacheSavingsUsd).toBeGreaterThan(0);
    // 64K context window triggers compaction penalty & cache invalidation
    expect(smallCtx!.compactionCount).toBeGreaterThan(0);
    expect(smallCtx!.totalUsd).toBeGreaterThan(high!.totalUsd);
    // Tracks average and peak context tokens across turns
    expect(high!.avgContextTokens).toBe(64_000);
    expect(high!.peakContextTokens).toBe(104_000);
  });

  it("classifies task scale by average context window rather than turn count", () => {
    // Many turns with tiny base context should remain light
    expect(
      classifyTaskScale({
        avgContextTokens: 2_000,
        turns: 20,
        avgOutputTokensPerTurn: 400,
      }).profile
    ).toBe("light");

    // Medium average context should be standard
    expect(
      classifyTaskScale({
        avgContextTokens: 64_000,
        turns: 11,
        avgOutputTokensPerTurn: 900,
      }).profile
    ).toBe("standard");

    // Large average context with few turns (e.g., deep research / literature review) should be heavy
    expect(
      classifyTaskScale({
        avgContextTokens: 140_000,
        turns: 6,
        avgOutputTokensPerTurn: 1_200,
      }).profile
    ).toBe("heavy");
  });
});

describe("Package D: unified multi-turn cost basis (mt-v2)", () => {
  const baseParams = {
    provider: "openai",
    contextWindow: 128_000,
    effortNormalized: "High",
    isReasoningModel: true,
    profile: "standard" as const,
  };

  it("reproduces the research-report standard High example exactly", () => {
    const res = calculateDeveloperAgentCost({
      ...baseParams,
      pricing: {
        inputPerMillion: 1,
        outputPerMillion: 4,
        cacheReadPerMillion: null,
        cacheWritePerMillion: null,
        currency: "USD",
      },
    });
    expect(res).not.toBeNull();
    // Exact token accounting (research report sec.3.2 / AC-D2)
    expect(res!.uncachedInputTokens).toBe(739_840);
    expect(res!.cachedReadTokens).toBe(0);
    expect(res!.cacheWriteTokens).toBe(0);
    expect(res!.outputTokens).toBe(64_700);
    expect(res!.thinkingTokens).toBe(52_800);
    expect(res!.compactionCount).toBe(1);
    // Exact money: 739840 * $1/M + 64700 * $4/M = $0.99864
    expect(res!.inputCostUsd).toBe(0.73984);
    expect(res!.outputCostUsd).toBe(0.2588);
    expect(res!.totalUsd).toBe(0.99864);
    expect(res!.templateVersion).toBe("mt-v2");
    expect(MULTI_TURN_TEMPLATE_VERSION).toBe("mt-v2");
    expect(res!.contextWindowAssumed).toBe(false);
  });

  it("reproduces the fixed cache-write fixture four-part breakdown exactly", () => {
    const res = calculateDeveloperAgentCost({
      ...baseParams,
      provider: "anthropic",
      pricing: {
        inputPerMillion: 1,
        outputPerMillion: 4,
        cacheReadPerMillion: 0.2,
        cacheWritePerMillion: 1.25,
        currency: "USD",
      },
    });
    expect(res).not.toBeNull();
    expect(res!.uncachedInputTokens).toBe(60_000);
    expect(res!.cachedReadTokens).toBe(540_000);
    expect(res!.cacheWriteTokens).toBe(139_840);
    expect(res!.outputTokens).toBe(64_700);
    expect(res!.compactionCount).toBe(1);
    expect(Math.round(res!.inputCostUsd * 1e6)).toBe(60_000);
    expect(Math.round(res!.cacheReadCostUsd * 1e6)).toBe(108_000);
    expect(Math.round(res!.cacheWriteCostUsd * 1e6)).toBe(174_800);
    expect(Math.round(res!.outputCostUsd * 1e6)).toBe(258_800);
    expect(Math.round(res!.totalUsd * 1e6)).toBe(601_600);
    expect(Math.round(res!.cacheSavingsUsd * 1e6)).toBe(397_040);

    // Same fixture with the explicit write price missing: Anthropic falls
    // back to 1.25x input and reaches the identical amount, flagged.
    const fallback = calculateDeveloperAgentCost({
      ...baseParams,
      provider: "anthropic",
      pricing: {
        inputPerMillion: 1,
        outputPerMillion: 4,
        cacheReadPerMillion: 0.2,
        cacheWritePerMillion: null,
        currency: "USD",
      },
    });
    expect(fallback).not.toBeNull();
    expect(Math.round(fallback!.totalUsd * 1e6)).toBe(601_600);
    expect(fallback!.cacheWritePriceFallback).toBe(true);
  });

  it("rejects negative and non-finite required prices; missing price is null; zero is legal", () => {
    const mk = (input: number | null, output: number | null) =>
      calculateDeveloperAgentCostDetailed({
        ...baseParams,
        pricing: {
          inputPerMillion: input,
          outputPerMillion: output,
          cacheReadPerMillion: null,
          cacheWritePerMillion: null,
          currency: "USD",
        },
      });
    expect(mk(-1, 4)).toEqual({ cost: null, reason: "invalid_price" });
    expect(mk(1, -0.5)).toEqual({ cost: null, reason: "invalid_price" });
    expect(mk(Number.NaN, 4).reason).toBe("invalid_price");
    expect(mk(1, Number.POSITIVE_INFINITY).reason).toBe("invalid_price");
    expect(mk(null, 4)).toEqual({ cost: null, reason: "missing_price" });
    expect(mk(1, null)).toEqual({ cost: null, reason: "missing_price" });
    const zero = mk(0, 0);
    expect(zero.cost).not.toBeNull();
    expect(zero.cost!.totalUsd).toBe(0);
  });

  it("treats invalid cache prices as missing (flagged) and keeps a legal zero", () => {
    const negRead = calculateDeveloperAgentCost({
      ...baseParams,
      provider: "anthropic",
      pricing: {
        inputPerMillion: 1,
        outputPerMillion: 4,
        cacheReadPerMillion: -0.2,
        cacheWritePerMillion: 1.25,
        currency: "USD",
      },
    });
    expect(negRead).not.toBeNull();
    expect(negRead!.cacheReadPriceFallback).toBe(true);
    expect(negRead!.hasCacheDiscount).toBe(false);
    expect(negRead!.cachedReadTokens).toBe(0);

    const zeroRead = calculateDeveloperAgentCost({
      ...baseParams,
      provider: "anthropic",
      pricing: {
        inputPerMillion: 1,
        outputPerMillion: 4,
        cacheReadPerMillion: 0,
        cacheWritePerMillion: 1.25,
        currency: "USD",
      },
    });
    expect(zeroRead).not.toBeNull();
    expect(zeroRead!.hasCacheDiscount).toBe(true);
    expect(zeroRead!.cacheReadCostUsd).toBe(0);
    expect(zeroRead!.cachedReadTokens).toBe(540_000);
  });

  it("applies the 128K fallback only to unreported windows and rejects invalid/small windows", () => {
    const pricing = {
      inputPerMillion: 1,
      outputPerMillion: 4,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
      currency: "USD" as const,
    };
    const assumed = calculateDeveloperAgentCost({
      ...baseParams,
      contextWindow: null,
      pricing,
    });
    const explicit = calculateDeveloperAgentCost({ ...baseParams, pricing });
    expect(assumed).not.toBeNull();
    expect(assumed!.contextWindowAssumed).toBe(true);
    expect(assumed!.totalUsd).toBe(explicit!.totalUsd);

    for (const bad of [0, -5, 128_000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        calculateDeveloperAgentCostDetailed({
          ...baseParams,
          contextWindow: bad,
          pricing,
        }).reason
      ).toBe("invalid_context_window");
    }
    // 8,000-token window: normal-turn cap = min(6400, 8000-900-4800)=2300,
    // below the 24,000 initial context -> not estimable, never truncated.
    expect(
      calculateDeveloperAgentCostDetailed({
        ...baseParams,
        contextWindow: 8_000,
        pricing,
      })
    ).toEqual({ cost: null, reason: "context_window_too_small" });
  });

  it("honours numeric thinking budgets 4096 / 32000 and rejects an oversized budget for the window", () => {
    const pricing = {
      inputPerMillion: 1,
      outputPerMillion: 4,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
      currency: "USD" as const,
    };
    const b4096 = calculateDeveloperAgentCost({
      ...baseParams,
      contextWindow: 256_000,
      effortNormalized: "4096 Tokens",
      pricing,
    });
    expect(b4096).not.toBeNull();
    expect(b4096!.thinkingTokens).toBe(45_056);
    expect(b4096!.outputTokens).toBe(54_956);
    expect(b4096!.compactionCount).toBe(0);

    const b32000 = calculateDeveloperAgentCost({
      ...baseParams,
      contextWindow: 256_000,
      effortNormalized: "32000 Tokens",
      pricing,
    });
    expect(b32000).not.toBeNull();
    expect(b32000!.thinkingTokens).toBe(352_000);
    expect(b32000!.outputTokens).toBe(361_900);

    // 40K window with a 32K budget leaves only 7,100 input tokens per turn:
    // the 24,000 initial context does not fit -> not estimable.
    expect(
      calculateDeveloperAgentCostDetailed({
        ...baseParams,
        contextWindow: 40_000,
        effortNormalized: "32000 Tokens",
        pricing,
      })
    ).toEqual({ cost: null, reason: "context_window_too_small" });
    // The 4,096 budget leaves a 32,000 cap and stays estimable.
    expect(
      calculateDeveloperAgentCost({
        ...baseParams,
        contextWindow: 40_000,
        effortNormalized: "4096 Tokens",
        pricing,
      })
    ).not.toBeNull();

    const b0 = calculateDeveloperAgentCost({
      ...baseParams,
      effortNormalized: "0 Tokens",
      pricing,
    });
    expect(b0).not.toBeNull();
    expect(b0!.thinkingTokens).toBe(0);
  });

  it("rejects overflow: huge finite prices that overflow the total yield no rankable amount", () => {
    const res = calculateDeveloperAgentCostDetailed({
      ...baseParams,
      pricing: {
        inputPerMillion: 1e308,
        outputPerMillion: 1e308,
        cacheReadPerMillion: null,
        cacheWritePerMillion: null,
        currency: "USD",
      },
    });
    expect(res.cost).toBeNull();
    expect(res.reason).toBe("numeric_overflow");
  });
});

describe("Package D: single selection entry point and five-surface consistency", () => {
  function makeRow(overrides: Partial<MeasurementRow> = {}): MeasurementRow {
    return {
      id: "m1",
      variantId: "v1",
      releaseId: "r1",
      creatorId: "c1",
      creatorName: "OpenAI",
      creatorSlug: "openai",
      creatorColor: "#000000",
      family: "GPT",
      releaseName: "Model One",
      releaseDate: "2026-01-01",
      contextWindow: 128_000,
      isOpenWeights: false,
      sourceUrl: "https://example.com",
      sourceSlug: "model-one-high",
      rawName: "Model One High",
      displayName: "Model One High",
      effortRaw: "High",
      effortNormalized: "High",
      effortOrder: 3,
      effortLadderType: "single",
      isReasoningModel: true,
      isGrouped: false,
      source: "artificial-analysis",
      indexName: "AA",
      indexVersion: "4.0",
      intelligenceScore: 50,
      codingScore: 50,
      agenticScore: 50,
      inputPricePerMillion: 1,
      outputPricePerMillion: 4,
      cacheReadPricePerMillion: null,
      cacheWritePricePerMillion: null,
      outputTokensPerSecond: null,
      timeToFirstToken: null,
      timePerTask: null,
      measuredAt: null,
      fetchedAt: "2026-11-26T00:00:00Z",
      pricingSource: "aa",
      snapshotId: "snap-1",
      agentUsage: {
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
      },
      agentCost: {
        p25: null,
        p50: null,
        p75: null,
        p90: null,
        mean: null,
        effective_cost: null,
        rasc: 999,
        estimated_cost: 0.99864,
        extra_tool_cost_mean: 7,
      },
      dataQuality: {
        level: "A",
        source_type: "measured_billed",
        sources: ["test"],
        updated_at: null,
      } as MeasurementRow["dataQuality"],
      ...overrides,
    };
  }

  it("getXAxisValue(eac) never falls back to RASC, at any tier", () => {
    const row = makeRow();
    // Even for an A-grade row carrying a RASC of 999, the eac axis is the
    // multi-turn simulation of the requested tier.
    expect(getXAxisValue(row, "eac", undefined, "standard")).toBe(0.99864);
    const heavy = getXAxisValue(row, "eac", undefined, "heavy");
    expect(heavy).toBe(getDeveloperAgentCost(row, "heavy")!.totalUsd);
    expect(heavy).not.toBe(999);
    // No-arg caller semantics preserved: default tier is standard.
    expect(getDeveloperAgentCost(row)!.totalUsd).toBe(0.99864);
    expect(getDeveloperAgentCost(row)!.profile).toBe("standard");
  });

  it("chart point, leaderboard amount, compare delta and target points share one amount", () => {
    const a = makeRow();
    const b = makeRow({
      id: "m2",
      variantId: "v2",
      displayName: "Model Two High",
      inputPricePerMillion: 2,
      intelligenceScore: 60,
      agentCost: {
        p25: null, p50: null, p75: null, p90: null, mean: null,
        effective_cost: null, rasc: 555, estimated_cost: null,
        extra_tool_cost_mean: null,
      },
    });
    const chartCost = getDeveloperAgentCost(a, "standard")!.totalUsd;
    const leaderboardCost = getXAxisValue(a, "eac", undefined, "standard");
    expect(leaderboardCost).toBe(chartCost);

    const pts = toTargetPoints([a, b], (r) =>
      getDeveloperAgentCost(r, "standard")!.totalUsd
    );
    const pa = pts.find((p) => p.id === "m1")!;
    const pb = pts.find((p) => p.id === "m2")!;
    expect(pa.cost).toBe(chartCost);
    const { pairwise } = compareVariants([pa, pb]);
    expect(pairwise).toHaveLength(1);
    expect(pairwise[0].costGapUsd).toBe(pa.cost - pb.cost);
    expect(pairwise[0].costRatio).toBeCloseTo(pa.cost / pb.cost, 12);

    // Default toTargetPoints getter uses the same simulated basis and does
    // not switch to RASC just because a row carries one.
    const defaultPts = toTargetPoints([a]);
    expect(defaultPts[0].cost).toBe(chartCost);
  });
});
