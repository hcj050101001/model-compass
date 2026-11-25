import { describe, expect, it } from "vitest";
import {
  calculateParetoFrontier,
  findDominators,
  isDominated,
} from "@/lib/analytics/pareto";
import type { ParetoPoint } from "@/lib/analytics/types";

describe("Pareto Frontier Algorithm", () => {
  it("identifies strict dominance and preserves exact ties", () => {
    const points: ParetoPoint[] = [
      { id: "a", cost: 0.1, score: 44.2, indexVersion: "5.0" },
      { id: "b_tie", cost: 0.1, score: 44.2, indexVersion: "5.0" }, // exact tie
      { id: "c_dominated", cost: 0.1, score: 40.0, indexVersion: "5.0" }, // same cost, lower score
      { id: "d_dominated", cost: 0.2, score: 44.2, indexVersion: "5.0" }, // higher cost, same score
      { id: "e", cost: 0.5, score: 58.0, indexVersion: "5.0" },
      { id: "f", cost: 1.0, score: 56.0, indexVersion: "5.0" }, // dominated by e
      { id: "g", cost: 1.5, score: 63.0, indexVersion: "5.0" },
    ];

    const res = calculateParetoFrontier(points);
    expect(Array.from(res.frontierIds)).toEqual(["a", "b_tie", "e", "g"]);
    expect(isDominated(points[2], points)).toBe(true);
    expect(isDominated(points[3], points)).toBe(true);
    expect(isDominated(points[0], points)).toBe(false);
    expect(findDominators(points[5], points).map((d) => d.id)).toEqual(["e"]);
  });

  it("handles zero-cost points without excluding them", () => {
    const points: ParetoPoint[] = [
      { id: "free", cost: 0, score: 38.4, indexVersion: "5.0" },
      { id: "cheap_worse", cost: 0.05, score: 35.1, indexVersion: "5.0" },
      { id: "paid_better", cost: 0.1, score: 45.0, indexVersion: "5.0" },
    ];
    const res = calculateParetoFrontier(points);
    expect(Array.from(res.frontierIds)).toEqual(["free", "paid_better"]);
  });

  it("excludes invalid/NaN/negative cost points and rejects mixed index versions", () => {
    const mixed: ParetoPoint[] = [
      { id: "v4", cost: 0.5, score: 60, indexVersion: "4.0" },
      { id: "v5", cost: 0.6, score: 65, indexVersion: "5.0" },
    ];
    expect(() => calculateParetoFrontier(mixed)).toThrow(/mixed indexVersion/);

    const withInvalid: ParetoPoint[] = [
      { id: "bad_nan", cost: Number.NaN, score: 90, indexVersion: "5.0" },
      { id: "bad_neg", cost: -1, score: 90, indexVersion: "5.0" },
      { id: "ok", cost: 1.0, score: 50, indexVersion: "5.0" },
    ];
    const res = calculateParetoFrontier(withInvalid);
    expect(res.evaluatedCount).toBe(1);
    expect(res.excludedCount).toBe(2);
    expect(Array.from(res.frontierIds)).toEqual(["ok"]);
  });
});
