import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { runSyncJob } from "@/lib/sync/engine";

export async function POST(request: Request) {
  const adminHeader = request.headers.get("x-admin-token");
  const expectedToken = process.env.ADMIN_TOKEN;
  const hasValidToken = Boolean(expectedToken && adminHeader === expectedToken);

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(sessionToken);

  if (!hasValidToken && !session.valid) {
    return NextResponse.json(
      { error: "Admin authorization required" },
      { status: 401 }
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
