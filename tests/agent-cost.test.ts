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
  classifyTaskScale,
} from "@/lib/agent-cost/developer-cost";
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
