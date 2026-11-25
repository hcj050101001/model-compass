import { cleanAndDeduplicateSessions } from "@/lib/agent-cost/cleaning";
import type { RawAgentSessionRecord } from "@/lib/agent-cost/types";
import { loadOtelLangfuseSessions } from "./otel-langfuse-adapter";
import { loadUserUploadedSessions } from "./user-upload-adapter";

export interface AgentSessionIngestionReport {
  /** Package C: "disabled" when ingestion short-circuited without touching any loader. */
  status: "disabled" | "completed";
  sessions: RawAgentSessionRecord[];
  sources: string[];
  rawCount: number;
  validCount: number;
  rejectedCount: number;
  duplicateCount: number;
  outOfWindowCount: number;
  outlierCount: number;
}

/**
 * Session ingestion is closed for the first launch (Package C, design
 * sec.2.4): there is no verified server-side collection pipeline yet, so
 * self-reported session files/URLs must never become measured evidence.
 * Ingestion only runs when explicitly enabled outside production via
 * AGENT_SESSION_INGESTION_ENABLED=true (controlled test/collection setups).
 */
export function isAgentSessionIngestionEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.AGENT_SESSION_INGESTION_ENABLED === "true"
  );
}

export async function ingestAllAgentSessions(options?: {
  windowDays?: number;
  otelDir?: string;
  uploadsDir?: string;
}): Promise<AgentSessionIngestionReport> {
  if (!isAgentSessionIngestionEnabled()) {
    // Short-circuit BEFORE probing any local directory, calling any loader,
    // or requesting any session URL: zero ingestion, zero outbound calls.
    return {
      status: "disabled",
      sessions: [],
      sources: [],
      rawCount: 0,
      validCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      outOfWindowCount: 0,
      outlierCount: 0,
    };
  }

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
    status: "completed",
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
