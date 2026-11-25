import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "./lib/auth";
import { getAuthConfigError, isPrivateMode } from "./lib/auth-config";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/logout",
  "/api/health",
  "/api/ready",
]);

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  if (getAuthConfigError()) {
    return NextResponse.json({ error: "Authentication unavailable" }, { status: 503 });
  }

  // The sync handler owns authorization for this route in both modes.
  if (!isPrivateMode() || pathname === "/api/admin/sync") {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);
  if (session.valid) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  // skipMiddlewareUrlNormalize preserves the listener origin so Next emits a relative Location.
  const redirect = new URL("/login", new URL(request.url).origin);
  redirect.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(redirect);
}

export const config = {
  // Next clones request bodies for Edge middleware. Send login and disabled uploads to their handlers directly.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth/login/?$|api/agent-sessions/upload/?$).*)"],
};
