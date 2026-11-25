import { dominates } from "./pareto";
import type { ParetoPoint } from "./types";

export interface AlternativeOptions {
  costTolerancePct: number; // e.g., 0, 2, 5, 10
  minScoreGain: number; // e.g., 0, 1, 2
}

export interface AlternativeMatch<T extends ParetoPoint> {
  candidate: T;
  costDiffUsd: number;
  costDiffPct: number | null;
  scoreDiff: number;
  kind: "strict_dominator" | "approximate_alternative" | "higher_score_similar_cost" | "lower_cost_similar_score";
}

export interface SuperiorAlternativesResult<T extends ParetoPoint> {
  strictDominators: AlternativeMatch<T>[];
  approximateAlternatives: AlternativeMatch<T>[];
  higherScoreSimilarCost: AlternativeMatch<T>[];
  lowerCostSimilarScore: AlternativeMatch<T>[];
}

function buildMatch<T extends ParetoPoint>(
  target: T,
  candidate: T,
  kind: AlternativeMatch<T>["kind"]
): AlternativeMatch<T> {
  const costDiffUsd = candidate.cost - target.cost;
  const costDiffPct =
    target.cost > 0 ? ((candidate.cost - target.cost) / target.cost) * 100 : null;
  const scoreDiff = candidate.score - target.score;
  return {
    candidate,
    costDiffUsd,
    costDiffPct,
    scoreDiff,
    kind,
  };
}

/**
 * Separates strict mathematical Pareto dominance from approximate superior alternatives
 * within a user-defined cost tolerance (%) and minimum score gain.
 */
export function findSuperiorAlternatives<T extends ParetoPoint>(
  target: T,
  candidates: T[],
  options: AlternativeOptions = { costTolerancePct: 5, minScoreGain: 1 }
): SuperiorAlternativesResult<T> {
  const strictDominators: AlternativeMatch<T>[] = [];
  const approximateAlternatives: AlternativeMatch<T>[] = [];
  const higherScoreSimilarCost: AlternativeMatch<T>[] = [];
  const lowerCostSimilarScore: AlternativeMatch<T>[] = [];

  const maxAllowedCost = target.cost * (1 + options.costTolerancePct / 100);
  const similarCostLow = target.cost * (1 - options.costTolerancePct / 100);

  for (const cand of candidates) {
    if (cand.id === target.id) continue;
    if (cand.indexVersion !== target.indexVersion) continue;
    if (
      !Number.isFinite(cand.cost) ||
      !Number.isFinite(cand.score) ||
      cand.cost < 0
    ) {
      continue;
    }

    if (dominates(cand, target)) {
      strictDominators.push(buildMatch(target, cand, "strict_dominator"));
      continue;
    }

    const scoreGain = cand.score - target.score;

    // Approximate superior alternative: slightly higher cost (within tolerance) for meaningful score gain
    if (
      cand.cost > target.cost &&
      cand.cost <= maxAllowedCost &&
      scoreGain >= options.minScoreGain
    ) {
      approximateAlternatives.push(
        buildMatch(target, cand, "approximate_alternative")
      );
    }

    // Higher score at similar cost (within +/- tolerance)
    if (
      cand.cost >= similarCostLow &&
      cand.cost <= maxAllowedCost &&
      scoreGain > 0
    ) {
      higherScoreSimilarCost.push(
        buildMatch(target, cand, "higher_score_similar_cost")
      );
    }

    // Lower cost at similar score (within +/- 1.5 points)
    if (cand.cost < target.cost && Math.abs(scoreGain) <= 1.5) {
      lowerCostSimilarScore.push(
        buildMatch(target, cand, "lower_cost_similar_score")
      );
    }
  }

  strictDominators.sort((a, b) => b.scoreDiff - a.scoreDiff || a.costDiffUsd - b.costDiffUsd);
  approximateAlternatives.sort((a, b) => b.scoreDiff - a.scoreDiff);
  higherScoreSimilarCost.sort((a, b) => b.scoreDiff - a.scoreDiff);
  lowerCostSimilarScore.sort((a, b) => a.costDiffUsd - b.costDiffUsd);

  return {
    strictDominators,
    approximateAlternatives,
    higherScoreSimilarCost,
    lowerCostSimilarScore,
  };
}
