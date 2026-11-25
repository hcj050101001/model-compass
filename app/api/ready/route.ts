import { NextResponse } from "next/server";
import { evaluateReadiness } from "@/lib/ops/readiness";

/**
 * Readiness (Package F): 200 only when the active publication is a
 * verified, non-demo, coverage-passing snapshot whose registered file is
 * readable and whose last successful verification fetch is within
 * MAX_SNAPSHOT_AGE_MINUTES. The public body carries only status/reason.
 */
export async function GET() {
  const result = await evaluateReadiness();
  if (result.ready) {
    return NextResponse.json(
      { status: "ready" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(
    { status: "not_ready", reason: result.reason },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}
