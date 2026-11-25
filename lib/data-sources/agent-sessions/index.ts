import { cleanAndDeduplicateSessions } from "@/lib/agent-cost/cleaning";
import type { RawAgentSessionRecord } from "@/lib/agent-cost/types";
import { loadOtelLangfuseSessions } from "./otel-langfuse-adapter";
import { loadUserUploadedSessions } from "./user-upload-adapter";

export interface AgentSessionIngestionReport {
  sessions: RawAgentSessionRecord[];
  sources: string[];
  rawCount: number;
  validCount: number;
  rejectedCount: number;
  duplicateCount: number;
  outOfWindowCount: number;
  outlierCount: number;
}

export async function ingestAllAgentSessions(options?: {
  windowDays?: number;
  otelDir?: string;
  uploadsDir?: string;
}): Promise<AgentSessionIngestionReport> {
  const [otel, uploads] = await Promise.all([
    loadOtelLangfuseSessions({ dirPath: options?.otelDir }),
    Promise.resolve(loadUserUploadedSessions({ dirPath: options?.uploadsDir })),
  ]);

  const rawRecords = [...otel.records, ...uploads.records];
  const sources = [...otel.sourceNames, ...uploads.sourceNames];

  const cleaned = cleanAndDeduplicateSessions(rawRecords, {
    windowDays: options?.windowDays ?? 30,
  });

  return {
    sessions: cleaned.validSessions,
    sources,
    rawCount: rawRecords.length,
    validCount: cleaned.validSessions.length,
    rejectedCount: cleaned.rejectedCount,
    duplicateCount: cleaned.duplicateCount,
    outOfWindowCount: cleaned.outOfWindowCount,
    outlierCount: cleaned.outlierCount,
  };
}
