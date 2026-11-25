export type AgentScenario =
  | "simple_coding"
  | "bug_fix"
  | "multi_file_engineering"
  | "large_repo_understanding"
  | "search_research"
  | "general_tool_use";

export type TaskComplexity = "light" | "medium" | "heavy";

export type DataQualityLevel = "A" | "B" | "C" | "D";

export type DataSourceType =
  | "measured_billed"
  | "measured_token_pricing"
  | "estimated"
  | "unavailable";

export interface TokenPricing {
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  currency: "USD";
}

export interface RawAgentCallRecord {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  billableOutputTokens: number;
  reasoningTokens?: number;
  reasoningIncludedInOutput?: boolean;
  succeeded?: boolean;
  isRetry?: boolean;
  isCompaction?: boolean;
  actualBilledUsd?: number | null;
}

export interface RawAgentSessionRecord {
  sessionId: string;
  userIdHash?: string | null;
  modelId: string;
  modelName?: string | null;
  provider: string;
  reasoningEffort?: string | null;
  scenario: AgentScenario;
  complexity: TaskComplexity;
  agentFramework?: string | null;
  contextScaleTokens?: number | null;
  succeeded: boolean;
  billingMode?: "api" | "subscription" | "unknown";
  actualBilledUsd?: number | null;
  extraToolCostUsd?: number | null;
  calls: RawAgentCallRecord[];
  timestamp: string;
  source: string;
}

export interface ScenarioStatistic {
  scenario: AgentScenario;
  sample_count: number;
  success_count: number;
  success_rate: number | null;
  mean_cost: number | null;
  p50_cost: number | null;
  effective_cost: number | null;
  sufficient: boolean;
}

export interface AgentUsageSummary {
  sample_count: number;
  independent_user_count: number;
  avg_input_tokens: number | null;
  avg_output_tokens: number | null;
  avg_reasoning_tokens: number | null;
  avg_cache_hit_rate: number | null;
  avg_api_calls: number | null;
  success_rate: number | null;
  time_range_start: string | null;
  time_range_end: string | null;
  scenario_statistics: ScenarioStatistic[];
}

export interface AgentCostSummary {
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  mean: number | null;
  effective_cost: number | null;
  rasc: number | null;
  estimated_cost: number | null;
  extra_tool_cost_mean: number | null;
}

export interface DataQualitySummary {
  level: DataQualityLevel;
  source_type: DataSourceType;
  sources: string[];
  updated_at: string | null;
  is_stale?: boolean;
  effort_token_diff_known?: boolean;
  low_sample_warning?: boolean;
  window_days?: number;
}

export interface StandardizedModelCostRecord {
  model_id: string;
  model_name: string;
  provider: string;
  reasoning_effort: string;
  intelligence_index: number | null;
  pricing: {
    input_per_million: number | null;
    output_per_million: number | null;
    cache_read_per_million: number | null;
    cache_write_per_million: number | null;
    currency: "USD";
  };
  agent_usage: AgentUsageSummary;
  agent_cost: AgentCostSummary;
  data_quality: DataQualitySummary;
}

export type ScenarioWeights = Record<AgentScenario, number>;

export interface CustomAgentParams {
  preset: TaskComplexity | "custom";
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reasoningIncludedInOutput: boolean;
  cacheHitRate: number;
  cacheWriteTokens: number;
  apiCalls: number;
  scenario: AgentScenario;
  complexity: TaskComplexity;
  includeExtraToolCost: boolean;
  scenarioWeights: ScenarioWeights;
}
