import { findSuperiorAlternatives, type AlternativeOptions } from "./alternatives";
import { dominates } from "./pareto";
import { getDeveloperAgentCost } from "@/lib/utils/format";
import type { MeasurementRow, ParetoPoint } from "./types";

export interface TargetPoint extends ParetoPoint {
  row: MeasurementRow;
}

export function toTargetPoints(
  rows: MeasurementRow[],
  costGetter?: (row: MeasurementRow) => number | null
): TargetPoint[] {
  // Unified cost basis (design sec.2.5): without an explicit getter every
  // row is priced by the SAME multi-turn simulation input used by sync,
  // home, API and export (standard tier). There is no global switch to
  // measured RASC when any row happens to carry one — measured and
  // simulated amounts are never mixed in one candidate set. The stored
  // estimated_cost is only a legacy fallback for rows the current template
  // cannot price (e.g. missing prices on legacy snapshots).
  const getCost =
    costGetter ??
    ((r: MeasurementRow) => {
      const dev = getDeveloperAgentCost(r, "standard");
      return dev ? dev.totalUsd : r.agentCost.estimated_cost;
    });

  return rows
    .map((r): TargetPoint | null => {
      const cost = getCost(r);
      if (
        typeof cost !== "number" ||
        !Number.isFinite(cost) ||
        cost < 0 ||
        typeof r.intelligenceScore !== "number" ||
        !Number.isFinite(r.intelligenceScore)
      ) {
        return null;
      }
      return {
        id: r.id,
        cost,
        score: r.intelligenceScore,
        indexVersion: r.indexVersion,
        qualityLevel: r.dataQuality.level,
        row: r,
      };
    })
    .filter((p): p is TargetPoint => p !== null);
}

// Mode A: Fixed Budget -> Highest Intelligence
export function findBestWithinBudget(
  points: TargetPoint[],
  maxCostUsd: number
): TargetPoint[] {
  return points
    .filter((p) => p.cost <= maxCostUsd)
    .sort((a, b) => b.score - a.score || a.cost - b.cost);
}

// Mode B: Fixed Intelligence -> Lowest Cost
export function findCheapestForIntelligence(
  points: TargetPoint[],
  minScore: number
): TargetPoint[] {
  return points
    .filter((p) => p.score >= minScore)
    .sort((a, b) => a.cost - b.cost || b.score - a.score);
}

// Mode C: Direct Comparison
export interface ComparisonPairwise {
  aId: string;
  bId: string;
  scoreGap: number;
  costGapUsd: number;
  costRatio: number | null;
  relation: "a_dominates_b" | "b_dominates_a" | "approximate_tradeoff" | "equivalent";
}

export function compareVariants(
  selected: TargetPoint[],
  tolerance: AlternativeOptions = { costTolerancePct: 5, minScoreGain: 1 }
): {
  items: TargetPoint[];
  pairwise: ComparisonPairwise[];
} {
  const pairwise: ComparisonPairwise[] = [];
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      const a = selected[i];
      const b = selected[j];
      let relation: ComparisonPairwise["relation"] = "approximate_tradeoff";
      if (a.cost === b.cost && a.score === b.score) {
        relation = "equivalent";
      } else if (dominates(a, b)) {
        relation = "a_dominates_b";
      } else if (dominates(b, a)) {
        relation = "b_dominates_a";
      } else {
        findSuperiorAlternatives(a, [b], tolerance);
      }

      pairwise.push({
        aId: a.id,
        bId: b.id,
        scoreGap: a.score - b.score,
        costGapUsd: a.cost - b.cost,
        costRatio: b.cost > 0 ? a.cost / b.cost : null,
        relation,
      });
    }
  }
  return { items: selected, pairwise };
}

// Mode D: Agent Routing Candidate Tiers
export interface RoutingTier {
  tierName: string;
  budgetRangeLabel: string;
  candidates: TargetPoint[];
  caveat: string;
}

export function buildAgentRoutingTiers(
  frontierPoints: TargetPoint[]
): RoutingTier[] {
  const sorted = [...frontierPoints].sort((a, b) => a.cost - b.cost);
  const pick = (minCost: number, maxCost: number) =>
    sorted
      .filter((p) => p.cost >= minCost && p.cost <= maxCost)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

  return [
    {
      tierName: "Low-Cost Tier",
      budgetRangeLabel: "≤ $0.15 / session",
      candidates: pick(0, 0.15),
      caveat:
        "Selected from Pareto-optimal variants; verify latency and domain-specific accuracy before production routing.",
    },
    {
      tierName: "Balanced Tier",
      budgetRangeLabel: "$0.15 – $1.00 / session",
      candidates: pick(0.150001, 1.0),
      caveat:
        "Balanced cost-intelligence band on Agent session cost.",
    },
    {
      tierName: "High-Intelligence Tier",
      budgetRangeLabel: "$1.00 – $3.50 / session",
      candidates: pick(1.000001, 3.5),
      caveat:
        "High-scoring frontier variants; not guaranteed to outperform all specialists on coding or agentic tasks.",
    },
    {
      tierName: "Flagship Reasoning Tier",
      budgetRangeLabel: "> $3.50 / session",
      candidates: pick(3.500001, Infinity),
      caveat:
        "Maximum measured intelligence tier with substantially higher per-session cost and latency.",
    },
  ];
}
