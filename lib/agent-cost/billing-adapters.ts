import type {
  RawAgentCallRecord,
  RawAgentSessionRecord,
  TokenPricing,
} from "./types";

export interface CallBillingResult {
  costUsd: number;
  usedCacheFallback: boolean;
}

export interface SessionBillingResult {
  sessionCostUsd: number;
  extraToolCostUsd: number;
  isActualBilled: boolean;
  usedCacheFallback: boolean;
}

export type ProviderBillingAdapterId =
  | "anthropic"
  | "openai"
  | "google"
  | "deepseek"
  | "alibaba"
  | "xai"
  | "moonshot"
  | "zhipu"
  | "minimax"
  | "default";

export function resolveBillingAdapter(provider: string): ProviderBillingAdapterId {
  const norm = provider.trim().toLowerCase();
  if (norm.includes("anthropic") || norm.includes("claude")) return "anthropic";
  if (norm.includes("openai")) return "openai";
  if (norm.includes("google") || norm.includes("gemini")) return "google";
  if (norm.includes("deepseek")) return "deepseek";
  if (norm.includes("alibaba") || norm.includes("qwen") || norm.includes("dashscope")) {
    return "alibaba";
  }
  if (norm.includes("xai") || norm.includes("grok")) return "xai";
  if (norm.includes("moonshot") || norm.includes("kimi")) return "moonshot";
  if (norm.includes("zhipu") || norm.includes("glm")) return "zhipu";
  if (norm.includes("minimax")) return "minimax";
  return "default";
}

function getEffectivePrices(
  adapter: ProviderBillingAdapterId,
  pricing: TokenPricing
): {
  priceInput: number;
  priceOutput: number;
  priceCacheRead: number;
  priceCacheWrite: number;
  usedCacheFallback: boolean;
} | null {
  // Package C: negative or non-finite prices are rejected outright, never
  // silently treated as 0.
  if (
    pricing.inputPerMillion === null ||
    pricing.outputPerMillion === null ||
    !Number.isFinite(pricing.inputPerMillion) ||
    !Number.isFinite(pricing.outputPerMillion) ||
    pricing.inputPerMillion < 0 ||
    pricing.outputPerMillion < 0
  ) {
    return null;
  }

  const priceInput = pricing.inputPerMillion;
  const priceOutput = pricing.outputPerMillion;
  const usedCacheFallback = pricing.cacheReadPerMillion === null;
  const priceCacheRead =
    pricing.cacheReadPerMillion !== null &&
    Number.isFinite(pricing.cacheReadPerMillion) &&
    pricing.cacheReadPerMillion >= 0
      ? pricing.cacheReadPerMillion
      : priceInput;

  let priceCacheWrite = 0;
  if (
    pricing.cacheWritePerMillion !== null &&
    Number.isFinite(pricing.cacheWritePerMillion) &&
    pricing.cacheWritePerMillion >= 0
  ) {
    priceCacheWrite = pricing.cacheWritePerMillion;
  } else if (adapter === "anthropic") {
    // Anthropic bills prompt cache writes (typically 1.25x input for 5m TTL)
    priceCacheWrite = priceInput * 1.25;
  }

  return {
    priceInput,
    priceOutput,
    priceCacheRead,
    priceCacheWrite,
    usedCacheFallback,
  };
}

/**
 * Deterministic single-call cost:
 * Cost_i = (UncachedInput_i * PriceInput + CachedInput_i * PriceCacheRead + CacheWrite_i * PriceCacheWrite + BillableOutput_i * PriceOutput) / 1_000_000
 * Reasoning tokens are NOT double-counted when already included in billableOutputTokens.
 */
export function calculateCallCost(
  call: RawAgentCallRecord,
  pricing: TokenPricing,
  provider: string
): CallBillingResult | null {
  if (
    typeof call.actualBilledUsd === "number" &&
    Number.isFinite(call.actualBilledUsd) &&
    call.actualBilledUsd >= 0
  ) {
    return { costUsd: call.actualBilledUsd, usedCacheFallback: false };
  }

  const adapter = resolveBillingAdapter(provider);
  const prices = getEffectivePrices(adapter, pricing);
  if (!prices) return null;

  const uncachedInput = Math.max(0, call.uncachedInputTokens);
  const cachedInput = Math.max(0, call.cachedInputTokens);
  const cacheWrite = Math.max(0, call.cacheWriteTokens);
  const reasoningIncluded = call.reasoningIncludedInOutput ?? true;
  const extraReasoning = reasoningIncluded
    ? 0
    : Math.max(0, call.reasoningTokens ?? 0);
  const billableOutput = Math.max(0, call.billableOutputTokens) + extraReasoning;

  const costUsd =
    (uncachedInput * prices.priceInput +
      cachedInput * prices.priceCacheRead +
      cacheWrite * prices.priceCacheWrite +
      billableOutput * prices.priceOutput) /
    1_000_000;

  return {
    costUsd,
    usedCacheFallback: prices.usedCacheFallback,
  };
}

/**
 * Deterministic session cost:
 * SessionCost = SUM(Cost_i) + (includeExtraToolCost ? ExtraToolCost : 0)
 * Rejects subscription-plan records from API cost computation.
 * Uses actual billed USD directly when provided by the data source.
 */
export function calculateSessionCost(
  session: RawAgentSessionRecord,
  pricing: TokenPricing,
  options?: { includeExtraToolCost?: boolean }
): SessionBillingResult | null {
  if (session.billingMode === "subscription") {
    return null;
  }

  const extraToolCostUsd =
    typeof session.extraToolCostUsd === "number" &&
    Number.isFinite(session.extraToolCostUsd) &&
    session.extraToolCostUsd >= 0
      ? session.extraToolCostUsd
      : 0;
  const toolAddon = options?.includeExtraToolCost ? extraToolCostUsd : 0;

  if (
    typeof session.actualBilledUsd === "number" &&
    Number.isFinite(session.actualBilledUsd) &&
    session.actualBilledUsd >= 0
  ) {
    return {
      sessionCostUsd: session.actualBilledUsd + toolAddon,
      extraToolCostUsd,
      isActualBilled: true,
      usedCacheFallback: false,
    };
  }

  if (session.calls.length === 0) {
    return null;
  }

  let totalModelCost = 0;
  let usedCacheFallback = false;

  for (const call of session.calls) {
    const res = calculateCallCost(call, pricing, session.provider);
    if (!res) return null;
    totalModelCost += res.costUsd;
    if (res.usedCacheFallback) usedCacheFallback = true;
  }

  return {
    sessionCostUsd: totalModelCost + toolAddon,
    extraToolCostUsd,
    isActualBilled: false,
    usedCacheFallback,
  };
}
