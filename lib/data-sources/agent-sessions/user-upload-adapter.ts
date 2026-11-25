import fs from "node:fs";
import path from "node:path";

/**
 * Reads user-volunteered anonymized Agent session logs from
 * `data/agent-sessions/uploads/` (JSON or JSONL).
 */
export function loadUserUploadedSessions(options?: {
  dirPath?: string;
}): { records: unknown[]; sourceNames: string[] } {
  const dirPath =
    options?.dirPath ??
    path.resolve(process.cwd(), "data", "agent-sessions", "uploads");
  const records: unknown[] = [];
  const sourceNames: string[] = [];

  if (!fs.existsSync(dirPath)) {
    return { records, sourceNames };
  }

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
          // Skip malformed line
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
        // Skip malformed file
      }
    }
    sourceNames.push(`user-upload:${file}`);
  }

  return { records, sourceNames };
}
