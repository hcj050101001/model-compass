import type { DataQualityLevel } from "@/lib/agent-cost/types";
import type { ParetoPoint } from "./types";

export interface ParetoResult<T extends ParetoPoint> {
  frontier: T[];
  frontierIds: Set<string>;
  evaluatedCount: number;
  excludedCount: number;
}

function isValidPoint(p: ParetoPoint): boolean {
  return (
    typeof p.cost === "number" &&
    Number.isFinite(p.cost) &&
    p.cost >= 0 &&
    typeof p.score === "number" &&
    Number.isFinite(p.score)
  );
}

/**
 * Returns true if candidate A strictly dominates B:
 * A.cost <= B.cost AND A.score >= B.score AND (A.cost < B.cost || A.score > B.score)
 * Only points within the same indexVersion are comparable.
 */
export function dominates(a: ParetoPoint, b: ParetoPoint): boolean {
  if (a.indexVersion !== b.indexVersion) return false;
  if (!isValidPoint(a) || !isValidPoint(b)) return false;
  return (
    a.cost <= b.cost &&
    a.score >= b.score &&
    (a.cost < b.cost || a.score > b.score)
  );
}

export function findDominators<T extends ParetoPoint>(
  point: T,
  candidates: T[]
): T[] {
  if (!isValidPoint(point)) return [];
  return candidates.filter((c) => c.id !== point.id && dominates(c, point));
}

export function isDominated<T extends ParetoPoint>(
  point: T,
  candidates: T[]
): boolean {
  if (!isValidPoint(point)) return false;
  return candidates.some((c) => c.id !== point.id && dominates(c, point));
}

/**
 * Computes the strict Pareto-optimal frontier over a set of valid points
 * sharing a single benchmark indexVersion.
 * Enforces strict isolation between real measured (A/B) and estimated (C) cost tiers,
 * and always excludes D (unavailable) when qualityLevel is present.
 * Preserves exact ties (same cost & same score).
 */
export function calculateParetoFrontier<T extends ParetoPoint>(
  points: T[],
  options?: {
    indexVersion?: string;
    allowedQualityLevels?: DataQualityLevel[];
  }
): ParetoResult<T> {
  const allowedSet = options?.allowedQualityLevels
    ? new Set(options.allowedQualityLevels)
    : null;

  const valid = points.filter((p) => {
    if (!isValidPoint(p)) return false;
    if (options?.indexVersion && p.indexVersion !== options.indexVersion) {
      return false;
    }
    if (p.qualityLevel === "D") return false;
    if (allowedSet && p.qualityLevel && !allowedSet.has(p.qualityLevel)) {
      return false;
    }
    return true;
  });

  // Enforce single version if not explicitly specified
  if (valid.length > 0 && !options?.indexVersion) {
    const firstVer = valid[0].indexVersion;
    const hasMixed = valid.some((p) => p.indexVersion !== firstVer);
    if (hasMixed) {
      throw new Error(
        "Cannot compute Pareto frontier across mixed indexVersion values."
      );
    }
  }

  // Enforce strict isolation between real (A/B) and estimated (C) quality levels
  if (!allowedSet) {
    const hasReal = valid.some(
      (p) => p.qualityLevel === "A" || p.qualityLevel === "B"
    );
    const hasEstimated = valid.some((p) => p.qualityLevel === "C");
    if (hasReal && hasEstimated) {
      throw new Error(
        "Cannot mix real measured costs (Grade A/B) and estimated costs (Grade C) in the same Pareto frontier."
      );
    }
  }

  // Sort ascending by cost, then descending by score
  const sorted = [...valid].sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    return b.score - a.score;
  });

  const frontier: T[] = [];
  let maxScoreSoFar = -Infinity;
  let lastFrontierCost = -Infinity;
  let lastFrontierScore = -Infinity;

  for (const pt of sorted) {
    if (pt.score > maxScoreSoFar) {
      frontier.push(pt);
      maxScoreSoFar = pt.score;
      lastFrontierCost = pt.cost;
      lastFrontierScore = pt.score;
    } else if (
      pt.cost === lastFrontierCost &&
      pt.score === lastFrontierScore
    ) {
      // Exact tie with the current frontier point: preserve both
      frontier.push(pt);
    }
  }

  return {
    frontier,
    frontierIds: new Set(frontier.map((p) => p.id)),
    evaluatedCount: valid.length,
    excludedCount: points.length - valid.length,
  };
}
