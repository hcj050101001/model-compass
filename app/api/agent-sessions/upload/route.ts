import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  containsSensitiveData,
  RawAgentSessionSchema,
} from "@/lib/agent-cost/cleaning";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0 || items.length > 200) {
    return NextResponse.json(
      { error: "Provide between 1 and 200 session records per upload." },
      { status: 400 }
    );
  }

  const accepted: string[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];

  const uploadDir = path.resolve(
    process.cwd(),
    "data",
    "agent-sessions",
    "uploads"
  );
  fs.mkdirSync(uploadDir, { recursive: true });
  const targetFile = path.join(uploadDir, "user-uploads.jsonl");

  const linesToAppend: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (containsSensitiveData(item)) {
      rejected.push({
        index: i,
        reason: "Sensitive fields or API keys detected and rejected.",
      });
      continue;
    }
    const parsed = RawAgentSessionSchema.safeParse(item);
    if (!parsed.success) {
      rejected.push({
        index: i,
        reason: "Schema validation failed.",
      });
      continue;
    }
    if (parsed.data.billingMode === "subscription") {
      rejected.push({
        index: i,
        reason: "Subscription-plan records cannot be used as API token costs.",
      });
      continue;
    }
    linesToAppend.push(JSON.stringify(parsed.data));
    accepted.push(parsed.data.sessionId);
  }

  if (linesToAppend.length > 0) {
    fs.appendFileSync(targetFile, `${linesToAppend.join("\n")}\n`, "utf8");
  }

  return NextResponse.json({
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    rejected,
  });
}
