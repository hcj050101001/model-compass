import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as sync } from "@/app/api/admin/sync/route";
import { POST as upload } from "@/app/api/agent-sessions/upload/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { register } from "@/instrumentation";
import { createSessionToken, SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getLoginReturnPath } from "@/lib/login-return-path";
import { runSyncJob } from "@/lib/sync/engine";
import { config, middleware } from "@/middleware";

vi.mock("@/lib/sync/engine", () => ({ runSyncJob: vi.fn() }));

const origin = "https://model-compass.local";
const password = randomBytes(32).toString("hex");
const sessionSecret = randomBytes(32).toString("hex");
const adminToken = randomBytes(32).toString("hex");

function loginRequest(value: string): Request {
  return new Request(`${origin}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ password: value }),
  });
}

function signedSession(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("PRIVATE_MODE", "true");
  vi.stubEnv("ACCESS_PASSWORD", password);
  vi.stubEnv("SESSION_SECRET", sessionSecret);
  vi.stubEnv("ADMIN_TOKEN", adminToken);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(runSyncJob).mockReset();
});

describe("production auth configuration", () => {
  const startupHalt = new Error("Startup halted");

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation(() => { throw startupHalt; });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each([
    ["PRIVATE_MODE", undefined],
    ["PRIVATE_MODE", "off"],
    ["SESSION_SECRET", undefined],
    ["SESSION_SECRET", "a0b1c2d3e4f5"],
    ["SESSION_SECRET", "dev-fallback-secret-change-in-prod"],
    ["SESSION_SECRET", "abcdefghijklmnop".repeat(2)],
    ["SESSION_SECRET", password],
    ["ACCESS_PASSWORD", undefined],
    ["ACCESS_PASSWORD", "a0b1c2d3e4f5"],
    ["ACCESS_PASSWORD", "replace-me-with-a-shared-password"],
  ])("rejects invalid %s at startup and closes protected paths (%#)", async (name, value) => {
    vi.stubEnv(name, value);
    expect(register).toThrow(startupHalt);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(name));
    for (const path of ["/compare", "/api/models", "/api/admin/sync"]) {
      expect((await middleware(new NextRequest(`${origin}${path}`))).status).toBe(503);
    }
    expect((await login(loginRequest(password))).status).toBe(503);
    await expect(createSessionToken()).rejects.toThrow(name);
  });

  it("requires both credentials even when public reads are enabled", async () => {
    vi.stubEnv("PRIVATE_MODE", "false");
    expect(register).not.toThrow();
    vi.stubEnv("SESSION_SECRET", undefined);
    expect(register).toThrow(startupHalt);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("SESSION_SECRET"));
    expect((await middleware(new NextRequest(`${origin}/api/models`))).status).toBe(503);
  });

  it("allows a build without runtime credentials", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("PRIVATE_MODE", undefined);
    vi.stubEnv("ACCESS_PASSWORD", undefined);
    vi.stubEnv("SESSION_SECRET", undefined);
    expect(register).not.toThrow();
  });
});

it.each(["/api/auth/login", "/api/agent-sessions/upload"])("routes %s without middleware buffering", (url) => {
  expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  expect(unstable_doesMiddlewareMatch({ config, url: `${url}/` })).toBe(false);
});

describe("viewer access", () => {
  it.each([
    { role: "admin", exp: Date.now() + 60_000 },
    { role: "viewer", exp: Date.now() + 60_000 },
    { v: 0, role: "viewer", exp: Date.now() + 60_000 },
    { v: 1, role: "admin", exp: Date.now() + 60_000 },
    { v: 1, role: "viewer", exp: Date.now() - 1 },
    { v: 1, role: "viewer", exp: "9999999999999" },
  ])("rejects an invalid signed session (%#)", async (payload) => {
    const session = signedSession(payload);
    expect(await verifySessionToken(session)).toEqual({ valid: false });
    const request = new NextRequest(`${origin}/api/models`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${session}` },
    });
    expect((await middleware(request)).status).toBe(401);
  });

  it("rejects sessions signed with an old key", async () => {
    const session = await createSessionToken();
    vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("hex"));
    expect(await verifySessionToken(session)).toEqual({ valid: false });
  });

  it("issues a secure viewer cookie, permits protected reads and clears the cookie on logout", async () => {
    const response = await login(loginRequest(password));
    expect(response.status).toBe(200);
    const cookieHeader = response.headers.get("set-cookie");
    expect(cookieHeader).toMatch(/; Secure\b/i);
    expect(cookieHeader).toMatch(/; HttpOnly\b/i);
    expect(cookieHeader).toMatch(/; SameSite=Lax\b/i);
    const session = response.cookies.get(SESSION_COOKIE_NAME)?.value;
    expect(await verifySessionToken(session)).toEqual({ valid: true, role: "viewer" });

    for (const path of ["/compare", "/settings", "/api/models"]) {
      const request = new NextRequest(`${origin}${path}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${session}` } });
      expect((await middleware(request)).headers.get("x-middleware-next")).toBe("1");
    }

    const cleared = await logout();
    expect(cleared.cookies.get(SESSION_COOKIE_NAME)?.value).toBe("");
    expect(cleared.headers.get("set-cookie")).toMatch(/; Max-Age=0\b/i);
    expect(cleared.headers.get("set-cookie")).toMatch(/; Secure\b/i);
    expect((await middleware(new NextRequest(`${origin}/settings`))).status).toBe(307);
    expect((await middleware(new NextRequest(`${origin}/api/models`))).status).toBe(401);
  });

  it.each(["/compare?model=a&model=b", "/settings?tab=recent"])("preserves the requested path %s", async (path) => {
    const response = await middleware(new NextRequest(`${origin}${path}`));
    expect(response.status).toBe(307);
    const loginUrl = new URL(response.headers.get("location") ?? "", origin);
    expect(loginUrl.origin).toBe(origin);
    expect(loginUrl.pathname).toBe("/login");
    expect(getLoginReturnPath(loginUrl.searchParams.get("next"))).toBe(path);
  });

  it("falls back to the homepage for a return URL outside the site", () => {
    expect(getLoginReturnPath("https://other.example/settings")).toBe("/");
  });

  it("rejects a wrong password without setting a cookie", async () => {
    const response = await login(loginRequest("incorrect"));
    expect(response.status).toBe(401);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("rejects a login body over the byte limit before issuing a cookie", async () => {
    const response = await login(loginRequest("多".repeat(1500)));
    expect(response.status).toBe(413);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
});

describe.each(["true", "false"])("sync and upload when PRIVATE_MODE=%s", (mode) => {
  beforeEach(() => vi.stubEnv("PRIVATE_MODE", mode));

  it("delegates sync to the handler and rejects absent, incorrect, and viewer-only credentials", async () => {
    const url = `${origin}/api/admin/sync`;
    const viewer = await createSessionToken();
    for (const headers of [new Headers(), new Headers({
      "x-admin-token": "incorrect",
    }), new Headers({ cookie: `${SESSION_COOKIE_NAME}=${viewer}` })]) {
      const request = new NextRequest(url, { method: "POST", headers });
      expect((await middleware(request)).headers.get("x-middleware-next")).toBe("1");
      expect((await sync(request)).status).toBe(403);
    }
    expect(runSyncJob).not.toHaveBeenCalled();
  });

  it.each([undefined, password, sessionSecret])("disables sync when the admin credential is unavailable or reused (%#)", async (value) => {
    vi.stubEnv("ADMIN_TOKEN", value);
    const request = new Request(`${origin}/api/admin/sync`, {
      method: "POST",
      headers: { "x-admin-token": value ?? adminToken },
    });
    expect((await sync(request)).status).toBe(403);
    expect(runSyncJob).not.toHaveBeenCalled();
  });

  it.each([
    ["success", 200],
    ["skipped_cooldown", 429],
    ["skipped_locked", 409],
    ["failed", 502],
  ] as const)("authorizes the operator and preserves %s as %i", async (status, httpStatus) => {
    const result = {
      jobId: "test-job",
      status,
      fetchedCount: 0,
      validCount: 0,
      rejectedCount: 0,
      rateLimitRemaining: null,
      rateLimitReset: null,
      isDemo: false,
    };
    vi.mocked(runSyncJob).mockResolvedValueOnce(result);
    const request = new NextRequest(`${origin}/api/admin/sync`, {
      method: "POST",
      headers: { "x-admin-token": adminToken },
    });
    expect((await middleware(request)).headers.get("x-middleware-next")).toBe("1");
    const response = await sync(request);
    expect(response.status).toBe(httpStatus);
    expect(await response.json()).toEqual(result);
    expect(runSyncJob).toHaveBeenCalledExactlyOnceWith({ manual: true });
  });

  it("rejects anonymous, viewer, and operator uploads without reading or creating anything", async () => {
    const directory = mkdtempSync(join(tmpdir(), "model-compass-upload-"));
    const localCwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    const postUpload: (request: Request) => Response = upload;
    try {
      const viewer = await createSessionToken();
      for (const headers of [new Headers(), new Headers({
        cookie: `${SESSION_COOKIE_NAME}=${viewer}`,
      }), new Headers({ "x-admin-token": adminToken })]) {
        const request = new NextRequest(`${origin}/api/agent-sessions/upload`, {
          method: "POST",
          body: '{"records":[]}',
          headers,
        });
        expect(postUpload(request).status).toBe(403);
        expect(request.bodyUsed).toBe(false);
      }
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      localCwd.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
