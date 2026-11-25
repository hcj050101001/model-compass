import crypto from "node:crypto";
import { z } from "zod";
import type { RawAgentSessionRecord } from "./types";

const SENSITIVE_KEY_PATTERN =
  /^(api_?key|secret|token|authorization|password|prompt|messages|code|repo_?content|file_?content)$/i;
const SECRET_VALUE_PATTERN = /(sk-[a-zA-Z0-9]{12,}|AIza[0-9A-Za-z\-_]{20,}|Bearer\s+[A-Za-z0-9\-._~+/]+=*)/;

export const RawAgentCallSchema = z.object({
  uncachedInputTokens: z.number().finite().min(0).max(50_000_000),
  cachedInputTokens: z.number().finite().min(0).max(50_000_000),
  cacheWriteTokens: z.number().finite().min(0).max(50_000_000),
  billableOutputTokens: z.number().finite().min(0).max(10_000_000),
  reasoningTokens: z.number().finite().min(0).max(10_000_000).optional(),
  reasoningIncludedInOutput: z.boolean().optional(),
  succeeded: z.boolean().optional(),
  isRetry: z.boolean().optional(),
  isCompaction: z.boolean().optional(),
  actualBilledUsd: z.number().finite().min(0).max(10_000).nullable().optional(),
});

export const RawAgentSessionSchema = z.object({
  sessionId: z.string().min(1).max(200),
  userIdHash: z.string().max(128).nullable().optional(),
  modelId: z.string().min(1).max(200),
  modelName: z.string().max(200).nullable().optional(),
  provider: z.string().min(1).max(100),
  reasoningEffort: z.string().max(64).nullable().optional(),
  scenario: z.enum([
    "simple_coding",
    "bug_fix",
    "multi_file_engineering",
    "large_repo_understanding",
    "search_research",
    "general_tool_use",
  ]),
  complexity: z.enum(["light", "medium", "heavy"]),
  agentFramework: z.string().max(100).nullable().optional(),
  contextScaleTokens: z.number().finite().min(0).max(50_000_000).nullable().optional(),
  succeeded: z.boolean(),
  billingMode: z.enum(["api", "subscription", "unknown"]).optional(),
  actualBilledUsd: z.number().finite().min(0).max(50_000).nullable().optional(),
  extraToolCostUsd: z.number().finite().min(0).max(10_000).nullable().optional(),
  calls: z.array(RawAgentCallSchema).min(1).max(1000),
  timestamp: z.string().datetime({ offset: true }).or(z.string().min(10)),
  source: z.string().min(1).max(100),
});

export function containsSensitiveData(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false;
  if (typeof obj === "string") {
    return SECRET_VALUE_PATTERN.test(obj);
  }
  if (Array.isArray(obj)) {
    return obj.some(containsSensitiveData);
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) return true;
      if (containsSensitiveData(v)) return true;
    }
  }
  return false;
}

export interface CleaningResult {
  validSessions: RawAgentSessionRecord[];
  rejectedCount: number;
  duplicateCount: number;
  outOfWindowCount: number;
  outlierCount: number;
  rejectionReasons: Record<string, number>;
}

export function cleanAndDeduplicateSessions(
  rawRecords: unknown[],
  options?: {
    windowDays?: number;
    now?: Date;
  }
): CleaningResult {
  const windowDays = options?.windowDays ?? 30;
  const nowMs = (options?.now ?? new Date()).getTime();
  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const validSessions: RawAgentSessionRecord[] = [];
  const rejectionReasons: Record<string, number> = {};

  let rejectedCount = 0;
  let duplicateCount = 0;
  let outOfWindowCount = 0;
  let outlierCount = 0;

  const bump = (reason: string) => {
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  };

  for (const raw of rawRecords) {
    if (containsSensitiveData(raw)) {
      rejectedCount += 1;
      bump("sensitive_data_detected");
      continue;
    }

    const parsed = RawAgentSessionSchema.safeParse(raw);
    if (!parsed.success) {
      rejectedCount += 1;
      bump("schema_validation_failed");
      continue;
    }

    const rec = parsed.data;
    if (rec.billingMode === "subscription") {
      rejectedCount += 1;
      bump("subscription_billing_excluded");
      continue;
    }

    const tsMs = Date.parse(rec.timestamp);
    if (!Number.isFinite(tsMs) || tsMs > nowMs + 86_400_000 || tsMs < cutoffMs) {
      outOfWindowCount += 1;
      bump("outside_time_window");
      continue;
    }

    // Sanity bounds for extreme outliers (e.g., > 50M total tokens or > $1000 per session)
    const totalTokens = rec.calls.reduce(
      (sum, c) =>
        sum + c.uncachedInputTokens + c.cachedInputTokens + c.cacheWriteTokens + c.billableOutputTokens,
      0
    );
    if (totalTokens <= 0 || totalTokens > 50_000_000) {
      outlierCount += 1;
      bump("token_outlier");
      continue;
    }
    if (
      typeof rec.actualBilledUsd === "number" &&
      (rec.actualBilledUsd < 0 || rec.actualBilledUsd > 1000)
    ) {
      outlierCount += 1;
      bump("cost_outlier");
      continue;
    }

    if (seenIds.has(rec.sessionId)) {
      duplicateCount += 1;
      bump("duplicate_session_id");
      continue;
    }

    const fp = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          m: rec.modelId,
          p: rec.provider,
          t: rec.timestamp,
          tot: totalTokens,
          c: rec.calls.length,
          b: rec.actualBilledUsd ?? null,
        })
      )
      .digest("hex");

    if (seenFingerprints.has(fp)) {
      duplicateCount += 1;
      bump("duplicate_fingerprint");
      continue;
    }

    seenIds.add(rec.sessionId);
    seenFingerprints.add(fp);
    validSessions.push(rec);
  }

  return {
    validSessions,
    rejectedCount,
    duplicateCount,
    outOfWindowCount,
    outlierCount,
    rejectionReasons,
  };
}
