import type {
  AgentCostSummary,
  AgentUsageSummary,
  DataQualityLevel,
  DataQualitySummary,
} from "@/lib/agent-cost/types";
import type { EffortLadderType } from "@/lib/normalization/effort";

export type XAxisMode =
  | "rasc"
  | "real_p50"
  | "eac"
  | "input_price"
  | "output_price"
  | "cache_read_price"
  | "custom_agent";

export type YAxisMetric = "intelligence" | "coding" | "agentic";

export interface MeasurementRow {
  id: string;
  variantId: string;
  releaseId: string;
  creatorId: string;
  creatorName: string;
  creatorSlug: string;
  creatorColor: string;
  family: string;
  releaseName: string;
  releaseDate: string | null;
  contextWindow: number | null;
  isOpenWeights: boolean | null;
  sourceUrl: string;
  sourceSlug: string;
  rawName: string;
  displayName: string;
  effortRaw: string | null;
  effortNormalized: string | null;
  effortOrder: number | null;
  effortLadderType: EffortLadderType;
  isReasoningModel: boolean | null;
  isGrouped: boolean;
  source: string;
  indexName: string;
  indexVersion: string;
  intelligenceScore: number | null;
  codingScore: number | null;
  agenticScore: number | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cacheReadPricePerMillion: number | null;
  cacheWritePricePerMillion: number | null;
  outputTokensPerSecond: number | null;
  timeToFirstToken: number | null;
  timePerTask: number | null;
  measuredAt: string | null;
  fetchedAt: string;
  pricingSource: string | null;
  snapshotId: string;
  agentUsage: AgentUsageSummary;
  agentCost: AgentCostSummary;
  dataQuality: DataQualitySummary;
}

export interface ParetoPoint {
  id: string;
  cost: number;
  score: number;
  indexVersion: string;
  qualityLevel?: DataQualityLevel;
}
