import { NextResponse, type NextRequest } from "next/server";
import {
  isPrivateMode,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "./lib/auth";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/health",
]);

export async function middleware(request: NextRequest) {
  if (!isPrivateMode()) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // Allow admin token header for programmatic admin sync
  if (pathname === "/api/admin/sync") {
    const adminHeader = request.headers.get("x-admin-token");
    const expected = process.env.ADMIN_TOKEN;
    if (expected && adminHeader === expected) {
      return NextResponse.next();
    }
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

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const origin = forwardedHost
    ? `${forwardedProto ?? "https"}://${forwardedHost}`
    : request.nextUrl.origin;
  const loginUrl = new URL("/login", origin);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
