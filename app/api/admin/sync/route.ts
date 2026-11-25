import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runSyncJob } from "@/lib/sync/engine";

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export async function POST(request: Request) {
  const adminHeader = request.headers.get("x-admin-token");
  const expectedToken = process.env.ADMIN_TOKEN;

  if (
    !adminHeader ||
    !expectedToken ||
    expectedToken === process.env.ACCESS_PASSWORD ||
    expectedToken === process.env.SESSION_SECRET ||
    !timingSafeEqual(tokenDigest(adminHeader), tokenDigest(expectedToken))
  ) {
    return NextResponse.json(
      { error: "Admin authorization required" },
      { status: 403 }
    );
  }

  const result = await runSyncJob({ manual: true });
  const httpStatus =
    result.status === "skipped_cooldown"
      ? 429
      : result.status === "skipped_locked"
        ? 409
        : result.status === "failed"
          ? 502
          : 200;

  return NextResponse.json(result, { status: httpStatus });
}
