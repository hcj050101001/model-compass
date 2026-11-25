import { NextResponse } from "next/server";
import { getAdminTokenConfigError } from "@/lib/auth-config";
import { credentialsMatch } from "@/lib/credentials-match";
import { runSyncJob } from "@/lib/sync/engine";

export async function POST(request: Request) {
  const adminHeader = request.headers.get("x-admin-token");
  const expectedToken = process.env.ADMIN_TOKEN;

  if (
    !adminHeader ||
    !expectedToken ||
    getAdminTokenConfigError(expectedToken) ||
    !credentialsMatch(adminHeader, expectedToken)
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
