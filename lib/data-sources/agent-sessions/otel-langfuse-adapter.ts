import fs from "node:fs";
import path from "node:path";

/**
 * Reads authorized, anonymized OpenTelemetry GenAI / Langfuse trace exports
 * from local directory `data/agent-sessions/otel/` (or optional `OTEL_SESSIONS_URL`).
 * Returns raw unknown records for strict schema + PII cleaning downstream.
 */
export async function loadOtelLangfuseSessions(options?: {
  dirPath?: string;
  remoteUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ records: unknown[]; sourceNames: string[] }> {
  const dirPath =
    options?.dirPath ??
    path.resolve(process.cwd(), "data", "agent-sessions", "otel");
  const records: unknown[] = [];
  const sourceNames: string[] = [];

  if (fs.existsSync(dirPath)) {
    const files = fs
      .readdirSync(dirPath)
      .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"));
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const raw = fs.readFileSync(fullPath, "utf8").trim();
      if (!raw) continue;
      if (file.endsWith(".jsonl")) {
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            records.push(JSON.parse(trimmed));
          } catch {
            // Skip malformed JSONL line
          }
        }
      } else {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            records.push(...parsed);
          } else {
            records.push(parsed);
          }
        } catch {
          // Skip malformed JSON file
        }
      }
      sourceNames.push(`otel:${file}`);
    }
  }

  const remoteUrl = options?.remoteUrl ?? process.env.OTEL_SESSIONS_URL?.trim();
  if (remoteUrl) {
    try {
      const fetchFn = options?.fetchImpl ?? fetch;
      const res = await fetchFn(remoteUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const parsed = await res.json();
        if (Array.isArray(parsed)) {
          records.push(...parsed);
          sourceNames.push("otel:remote");
        }
      }
    } catch {
      // Optional remote source unreachable; do not fail sync
    }
  }

  return { records, sourceNames };
}
