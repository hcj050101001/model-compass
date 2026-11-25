import { describe, expect, it } from "vitest";
import { findSuperiorAlternatives } from "@/lib/analytics/alternatives";
import { calculateEffortMarginalReturns } from "@/lib/analytics/marginal";
import {
  buildAgentRoutingTiers,
  findBestWithinBudget,
  findCheapestForIntelligence,
} from "@/lib/analytics/targets";
import {
  calculateBlendedPrice,
  calculateCustomWorkloadCost,
} from "@/lib/analytics/workload";
import { mapAAModelsToNormalized } from "@/lib/data-sources/artificial-analysis/mapper";
import { getDemoAAModels, DEMO_INDEX_VERSION } from "@/lib/data-sources/demo/dataset";
import { toTargetPoints } from "@/lib/analytics/targets";
import { calculateEAC, DEFAULT_AGENT_PARAMS } from "@/lib/agent-cost/eac";
import { classifyDataQuality } from "@/lib/agent-cost/quality";
import type { MeasurementRow, ParetoPoint } from "@/lib/analytics/types";

describe("Analytics Engine", () => {
  it("distinguishes strict dominance from approximate superior alternatives", () => {
    const target: ParetoPoint = {
      id: "hydrogen_high",
      cost: 1.87,
      score: 51.0,
      indexVersion: "5.0",
    };
    const approx: ParetoPoint = {
      id: "neon_medium",
      cost: 1.9, // +1.6% cost
      score: 54.9, // +3.9 pts
      indexVersion: "5.0",
    };
    const strict: ParetoPoint = {
      id: "better_cheaper",
      cost: 1.5,
      score: 55.0,
      indexVersion: "5.0",
    };

    const res = findSuperiorAlternatives(target, [target, approx, strict], {
      costTolerancePct: 2,
      minScoreGain: 2,
    });
    expect(res.strictDominators.map((m) => m.candidate.id)).toEqual(["better_cheaper"]);
    expect(res.approximateAlternatives.map((m) => m.candidate.id)).toEqual(["neon_medium"]);
  });

  it("handles marginal effort returns including zero-cost delta and score decrease", () => {
    const steps = calculateEffortMarginalReturns([
      { id: "low", label: "Low", effortOrder: 20, score: 50, cost: 1.0 },
      { id: "med", label: "Medium", effortOrder: 30, score: 55, cost: 2.0 },
      { id: "high", label: "High", effortOrder: 40, score: 54, cost: 3.0 }, // score dip
      { id: "xhigh", label: "XHigh", effortOrder: 60, score: 56, cost: 3.0 }, // zero cost delta
    ]);

    expect(steps).toHaveLength(3);
    expect(steps[0].status).toBe("normal");
    expect(steps[0].scorePerDollar).toBeCloseTo(5.0);
    expect(steps[1].status).toBe("score_decreased");
    expect(steps[1].scorePerDollar).toBeNull();
    expect(steps[2].status).toBe("free_upgrade");
    expect(steps[2].scorePerDollar).toBeNull();
  });

  it("computes blended price and custom workload without double-counting reasoning tokens", () => {
    const blended = calculateBlendedPrice(2.0, 6.0, 0.75);
    expect(blended?.blendedPricePerMillion).toBeCloseTo(3.0);

    const included = calculateCustomWorkloadCost(
      {
        inputPricePerMillion: 1.0,
        outputPricePerMillion: 4.0,
        cacheReadPricePerMillion: 0.25,
      },
      {
        inputTokensPerTask: 10000,
        cacheHitTokensPerTask: 4000,
        outputTokensPerTask: 2000,
        reasoningTokensPerTask: 4000,
        reasoningIncludedInOutput: true,
        tasksPerDay: 10,
        workingDaysPerMonth: 20,
      }
    );
    // Uncached input: 6k * $1/1M = $0.006
    // Cache read: 4k * $0.25/1M = $0.001
    // Output (reasoning included): 2k * $4/1M = $0.008 -> total $0.015
    expect(included?.perTaskUsd).toBeCloseTo(0.015);
    expect(included?.dailyUsd).toBeCloseTo(0.15);
    expect(included?.monthlyUsd).toBeCloseTo(3.0);

    const separate = calculateCustomWorkloadCost(
      {
        inputPricePerMillion: 1.0,
        outputPricePerMillion: 4.0,
        cacheReadPricePerMillion: 0.25,
      },
      {
        inputTokensPerTask: 10000,
        cacheHitTokensPerTask: 4000,
        outputTokensPerTask: 2000,
        reasoningTokensPerTask: 4000,
        reasoningIncludedInOutput: false,
        tasksPerDay: 10,
        workingDaysPerMonth: 20,
      }
    );
    expect(separate?.perTaskUsd).toBeCloseTo(0.031);
  });

  it("finds budget-constrained, intelligence-constrained, and routing tiers on demo data", () => {
    const bundle = mapAAModelsToNormalized({
      items: getDemoAAModels(),
      indexVersion: DEMO_INDEX_VERSION,
      fetchedAt: "2026-11-25T00:00:00Z",
      source: "demo-synthetic",
    });

    const rows: MeasurementRow[] = bundle.measurements.map((m) => {
      const v = bundle.variants.find((x) => x.id === m.variantId)!;
      const r = bundle.releases.find((x) => x.id === v.modelReleaseId)!;
      const c = bundle.creators.find((x) => x.id === r.creatorId)!;
      const pricing = {
        inputPerMillion: m.inputPricePerMillion,
        outputPerMillion: m.outputPricePerMillion,
        cacheReadPerMillion: m.cacheReadPricePerMillion,
        cacheWritePerMillion: m.cacheWritePricePerMillion,
        currency: "USD" as const,
      };
      const eac = calculateEAC(pricing, DEFAULT_AGENT_PARAMS);
      const usage = {
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
      const cost = {
        p25: null,
        p50: null,
        p75: null,
        p90: null,
        mean: null,
        effective_cost: null,
        rasc: null,
        estimated_cost: eac ? eac.estimatedCostUsd : null,
        extra_tool_cost_mean: null,
      };
      return {
        ...m,
        releaseId: r.id,
        creatorId: c.id,
        creatorName: c.name,
        creatorSlug: c.slug,
        creatorColor: c.color,
        family: r.family,
        releaseName: r.name,
        releaseDate: r.releaseDate,
        contextWindow: r.contextWindow,
        isOpenWeights: r.isOpenWeights,
        sourceSlug: v.sourceSlug,
        rawName: v.rawName,
        displayName: v.displayName,
        effortRaw: v.effortRaw,
        effortNormalized: v.effortNormalized,
        effortOrder: v.effortOrder,
        effortLadderType: v.effortLadderType,
        isReasoningModel: v.isReasoningModel,
        isGrouped: v.isGrouped,
        snapshotId: "test",
        agentUsage: usage,
        agentCost: cost,
        dataQuality: classifyDataQuality({
          usage,
          cost,
          pricing,
          hasActualBilledSessions: false,
          allSessionsBilled: false,
          sources: ["demo-synthetic"],
          updatedAt: "2026-11-25T00:00:00Z",
        }),
      };
    });

    const pts = toTargetPoints(rows);
    const under50c = findBestWithinBudget(pts, 0.5);
    expect(under50c.length).toBeGreaterThan(0);
    expect(under50c[0].cost).toBeLessThanOrEqual(0.5);

    const above60 = findCheapestForIntelligence(pts, 60);
    expect(above60.length).toBeGreaterThan(0);
    expect(above60[0].score).toBeGreaterThanOrEqual(60);

    const tiers = buildAgentRoutingTiers(pts);
    expect(tiers).toHaveLength(4);
  });
});
