import fs from "node:fs";
import path from "node:path";
import { MAINSTREAM_PROVIDER_SET } from "@/lib/analytics/homepage-providers";

/**
 * Coverage data gate (Package E, design §2.6). Thresholds are the
 * like-for-like recomputed basis at 80% (ceil), landed in
 * config/coverage-thresholds.json and shared by the production sync gate,
 * snapshot validation and CI. The values are PROVISIONAL (E-3) pending the
 * deployment owner's confirmation; environment variables
 * MIN_SCORED_MODELS / MIN_POSITIVE_ESTIMATE_MODELS override the file when
 * set to positive integers.
 */

export interface CoverageThresholds {
  minScoredModels: number;
  minPositiveEstimateModels: number;
  provisional: boolean;
}

export interface CoverageCounts {
  scoredModels: number;
  positiveEstimateModels: number;
}

interface CoverageConfigFile {
  minScoredModels?: unknown;
  minPositiveEstimateModels?: unknown;
  provisional?: unknown;
}

let cachedFileThresholds: CoverageThresholds | null = null;

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function envOverride(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function getCoverageThresholds(): CoverageThresholds {
  if (!cachedFileThresholds) {
    const configPath = path.resolve(
      process.cwd(),
      "config/coverage-thresholds.json"
    );
    const parsed = JSON.parse(
      fs.readFileSync(configPath, "utf8")
    ) as CoverageConfigFile;
    cachedFileThresholds = {
      minScoredModels: positiveInt(parsed.minScoredModels) ?? 1,
      minPositiveEstimateModels:
        positiveInt(parsed.minPositiveEstimateModels) ?? 1,
      provisional: parsed.provisional === true,
    };
  }
  return {
    minScoredModels:
      envOverride("MIN_SCORED_MODELS") ?? cachedFileThresholds.minScoredModels,
    minPositiveEstimateModels:
      envOverride("MIN_POSITIVE_ESTIMATE_MODELS") ??
      cachedFileThresholds.minPositiveEstimateModels,
    provisional: cachedFileThresholds.provisional,
  };
}

export interface CoverageCandidate {
  intelligenceScore: number | null;
  creatorSlug: string;
  estimatedCost: number | null;
}

/** Like-for-like counting used for the threshold basis and the gate. */
export function countCoverage(
  candidates: CoverageCandidate[]
): CoverageCounts {
  let scoredModels = 0;
  let positiveEstimateModels = 0;
  for (const c of candidates) {
    const hasScore =
      typeof c.intelligenceScore === "number" &&
      Number.isFinite(c.intelligenceScore);
    if (hasScore) scoredModels += 1;
    if (
      hasScore &&
      MAINSTREAM_PROVIDER_SET.has(c.creatorSlug) &&
      typeof c.estimatedCost === "number" &&
      Number.isFinite(c.estimatedCost) &&
      c.estimatedCost > 0
    ) {
      positiveEstimateModels += 1;
    }
  }
  return { scoredModels, positiveEstimateModels };
}

export function evaluateCoverage(counts: CoverageCounts): {
  ok: boolean;
  failures: string[];
  thresholds: CoverageThresholds;
} {
  const thresholds = getCoverageThresholds();
  const failures: string[] = [];
  if (counts.scoredModels < thresholds.minScoredModels) {
    failures.push(
      `scored models ${counts.scoredModels} below minimum ${thresholds.minScoredModels}`
    );
  }
  if (counts.positiveEstimateModels < thresholds.minPositiveEstimateModels) {
    failures.push(
      `positive-estimate homepage models ${counts.positiveEstimateModels} below minimum ${thresholds.minPositiveEstimateModels}`
    );
  }
  // Hard floor independent of configuration: at least one scored homepage
  // candidate with a positive estimate must exist.
  if (counts.positiveEstimateModels < 1) {
    failures.push("no homepage candidate with score and positive estimate");
  }
  return { ok: failures.length === 0, failures, thresholds };
}
