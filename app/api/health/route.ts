import { NextResponse } from "next/server";

/**
 * Liveness only (Package F probe split): answers that the web process is
 * up. It must not touch the database or leak snapshot/demo details —
 * data-plane readiness lives in /api/ready.
 */
export async function GET() {
  return NextResponse.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
