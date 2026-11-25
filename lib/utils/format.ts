import {
  calculateDeveloperAgentCost,
  type DeveloperAgentCostBreakdown,
  type DeveloperTaskProfile,
} from "@/lib/agent-cost/developer-cost";
import { calculateEAC } from "@/lib/agent-cost/eac";
import { computeRealAgentStatsAndRasc } from "@/lib/agent-cost/rasc";
import type { CustomAgentParams, DataQualityLevel } from "@/lib/agent-cost/types";
import type { MeasurementRow, XAxisMode, YAxisMetric } from "@/lib/analytics/types";

export function formatUsd(val: number | null | undefined, digits = 2): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "—";
  if (val === 0) return "$0.00";
  if (val < 0.01) return `$${val.toFixed(4)}`;
  if (val < 1) return `$${val.toFixed(3)}`;
  return `$${val.toFixed(digits)}`;
}

export function formatScore(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "—";
  return val.toFixed(1);
}

export function formatSpeed(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "—";
  return `${Math.round(val)} tok/s`;
}

export function formatLatency(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "—";
  return `${val.toFixed(2)}s`;
}

export function formatPercent(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "—";
  return `${(val * 100).toFixed(1)}%`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function isRealCostMode(mode: XAxisMode): boolean {
  return mode === "rasc" || mode === "real_p50";
}

export function isEstimatedCostMode(mode: XAxisMode): boolean {
  return mode === "eac" || mode === "custom_agent";
}

export function getDataQualityLabel(
  level: DataQualityLevel,
  locale: "zh" | "en" = "zh"
): string {
  if (locale === "zh") {
    switch (level) {
      case "A":
        return "A级 · 实测账单";
      case "B":
        return "B级 · 实测Token";
      case "C":
        return "C级 · 标准化估算";
      case "D":
        return "D级 · 暂无数据";
    }
  }
  switch (level) {
    case "A":
      return "Grade A · Measured (Billed)";
    case "B":
      return "Grade B · Measured (Tokens)";
    case "C":
      return "Grade C · Estimated";
    case "D":
      return "Grade D · Unavailable";
  }
}

export function getDeveloperAgentCost(
  row: MeasurementRow,
  profile: DeveloperTaskProfile = "standard"
): DeveloperAgentCostBreakdown | null {
  return calculateDeveloperAgentCost({
    pricing: {
      inputPerMillion: row.inputPricePerMillion,
      outputPerMillion: row.outputPricePerMillion,
      cacheReadPerMillion: row.cacheReadPricePerMillion,
      cacheWritePerMillion: row.cacheWritePricePerMillion,
      currency: "USD",
    },
    provider: row.creatorSlug,
    contextWindow: row.contextWindow,
    effortNormalized: row.effortNormalized,
    isReasoningModel: row.isReasoningModel,
    profile,
  });
}

export function getXAxisValue(
  row: MeasurementRow,
  mode: XAxisMode,
  agentParams?: CustomAgentParams,
  taskProfile: DeveloperTaskProfile = "standard"
): number | null {
  switch (mode) {
    case "rasc": {
      if (row.dataQuality.level !== "A" && row.dataQuality.level !== "B") {
        return null;
      }
      return row.agentCost.rasc;
    }
    case "real_p50": {
      if (row.dataQuality.level !== "A" && row.dataQuality.level !== "B") {
        return null;
      }
      return row.agentCost.p50;
    }
    case "eac": {
      if (
        (row.dataQuality.level === "A" || row.dataQuality.level === "B") &&
        row.agentCost.rasc !== null
      ) {
        return row.agentCost.rasc;
      }
      const dev = getDeveloperAgentCost(row, taskProfile);
      return dev ? dev.totalUsd : null;
    }
    case "custom_agent": {
      if (!agentParams) return row.agentCost.estimated_cost;
      const res = calculateEAC(
        {
          inputPerMillion: row.inputPricePerMillion,
          outputPerMillion: row.outputPricePerMillion,
          cacheReadPerMillion: row.cacheReadPricePerMillion,
          cacheWritePerMillion: row.cacheWritePricePerMillion,
          currency: "USD",
        },
        agentParams
      );
      if (!res) return null;
      const toolAddon =
        agentParams.includeExtraToolCost &&
        typeof row.agentCost.extra_tool_cost_mean === "number"
          ? row.agentCost.extra_tool_cost_mean
          : 0;
      return res.estimatedCostUsd + toolAddon;
    }
    case "input_price":
      return row.inputPricePerMillion;
    case "output_price":
      return row.outputPricePerMillion;
    case "cache_read_price":
      return row.cacheReadPricePerMillion;
  }
}

export function getXAxisLabel(
  mode: XAxisMode,
  locale: "zh" | "en" = "en"
): string {
  if (locale === "zh") {
    switch (mode) {
      case "rasc":
        return "真实 Agent 有效任务成本 RASC (USD / 有效任务 — 实测)";
      case "real_p50":
        return "真实 Agent 会话成本中位数 P50 (USD / 会话 — 实测)";
      case "eac":
        return "标准化 Agent 估算成本 EAC (USD / 任务 — 估算)";
      case "custom_agent":
        return "自定义 Agent 使用成本 (USD / 任务 — 估算)";
      case "input_price":
        return "百万输入 Token 价格 (USD / 1M Tokens)";
      case "output_price":
        return "百万输出 Token 价格 (USD / 1M Tokens)";
      case "cache_read_price":
        return "百万缓存读取 Token 价格 (USD / 1M Tokens)";
    }
  }
  switch (mode) {
    case "rasc":
      return "Real-world Agent Session Cost RASC (USD / Effective Task — Measured)";
    case "real_p50":
      return "Real Agent Session Median P50 (USD / Session — Measured)";
    case "eac":
      return "Est. Agent Session Cost ($)";
    case "custom_agent":
      return "Custom Agent Cost (USD / Task — Estimated)";
    case "input_price":
      return "Input Price (USD / 1M Tokens)";
    case "output_price":
      return "Output Price (USD / 1M Tokens)";
    case "cache_read_price":
      return "Cache Read Price (USD / 1M Tokens)";
  }
}

export function getYAxisLabel(
  metric: YAxisMetric,
  indexVersion: string,
  locale: "zh" | "en" = "en"
): string {
  const v = indexVersion ? `v${indexVersion}` : "";
  if (locale === "zh") {
    switch (metric) {
      case "intelligence":
        return `AA 综合智力指数 (${v})`;
      case "coding":
        return `AA 编程指数 (${v})`;
      case "agentic":
        return `AA 智能体指数 (${v})`;
    }
  }
  switch (metric) {
    case "intelligence":
      return `AA Intelligence Index (${v})`;
    case "coding":
      return `AA Coding Index (${v})`;
    case "agentic":
      return `AA Agentic Index (${v})`;
  }
}

export function getEffortShape(effortNormalized: string | null): string {
  switch (effortNormalized) {
    case "Non-thinking":
      return "diamond";
    case "Minimal":
      return "triangle";
    case "Low":
      return "circle";
    case "Medium":
      return "rect";
    case "High":
      return "roundRect";
    case "Very High":
    case "XHigh":
    case "Max":
      return "pin";
    default:
      return "circle";
  }
}

const CREATOR_DISPLAY_NAMES_ZH: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic / Claude",
  google: "谷歌 / Gemini",
  xai: "xAI / Grok",
  deepseek: "DeepSeek",
  alibaba: "阿里 / 通义千问",
  zhipu: "智谱 / GLM",
  moonshot: "月之暗面 / Kimi",
  minimax: "MiniMax",
  "bytedance-seed": "字节 / 豆包",
  meta: "Meta / Llama",
  tencent: "腾讯 / 混元",
  baidu: "百度 / 文心",
  xiaomi: "小米",
  stepfun: "阶跃星辰",
};

const CREATOR_DISPLAY_NAMES_EN: Record<string, string> = {
  zhipu: "Zhipu / GLM",
  "bytedance-seed": "ByteDance / Doubao",
  tencent: "Tencent / Hunyuan",
  baidu: "Baidu / ERNIE",
};

export function getCreatorDisplayName(
  creatorSlug: string,
  fallbackName: string,
  locale: "zh" | "en" = "zh"
): string {
  if (locale === "zh") {
    return CREATOR_DISPLAY_NAMES_ZH[creatorSlug] ?? fallbackName;
  }
  return CREATOR_DISPLAY_NAMES_EN[creatorSlug] ?? fallbackName;
}

// Keep unused import guard satisfied if needed
export { computeRealAgentStatsAndRasc };
