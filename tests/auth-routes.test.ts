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
const syncResult = {
  jobId: "test-job",
  status: "success",
  fetchedCount: 0,
  validCount: 0,
  rejectedCount: 0,
  rateLimitRemaining: null,
  rateLimitReset: null,
  isDemo: false,
} as const;

function loginRequest(value: string, forwardedFor?: string): Request {
  return new Request(`${origin}/api/auth/login`, {
    method: "POST",
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : undefined,
    body: JSON.stringify({ password: value }),
  });
}

function syncRequest(token: string, forwardedFor?: string): Request {
  const headers = new Headers({ "x-admin-token": token });
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  return new Request(`${origin}/api/admin/sync`, { method: "POST", headers });
}

function streamedLoginRequest(body: Uint8Array): Request {
  const chunks = [body.subarray(0, 21), body.subarray(21, 32), body.subarray(32)];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const init: RequestInit & { duplex: "half" } = { method: "POST", body: stream, duplex: "half" };
  return new Request(`${origin}/api/auth/login`, init);
}

function signedSession(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function expectCredentialDelay(pending: Promise<Response>, delay: number, status: number) {
  const completed = vi.fn<(response: Response) => void>();
  void pending.then(completed);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(completed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status }));
  return pending;
}

let testTime = Date.now();

beforeEach(() => {
  // Separate tests by more than the shared failure window.
  testTime += 120_000;
  vi.spyOn(Date, "now").mockReturnValue(testTime);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("PRIVATE_MODE", "true");
  vi.stubEnv("ACCESS_PASSWORD", password);
  vi.stubEnv("SESSION_SECRET", sessionSecret);
  vi.stubEnv("ADMIN_TOKEN", adminToken);
  vi.stubEnv("TRUST_PROXY", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(runSyncJob).mockReset();
});

describe("auth configuration at startup", () => {
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
    ["SESSION_SECRET", "123456789012345678901234567890ab"],
    ["SESSION_SECRET", "abcdefghijklmnopqrstuvwxyz123456"],
    ["SESSION_SECRET", "qwertyuiopasdfghjklzxcvbnm123456"],
    ["SESSION_SECRET", "987654321098765432109876543210ab"],
    ["SESSION_SECRET", "ZYXWVUTSRQPONMLKJIHGFEDCBA123456"],
    ["SESSION_SECRET", password],
    ["ACCESS_PASSWORD", undefined],
    ["ACCESS_PASSWORD", "a0b1c2d3e4f5"],
    ["ACCESS_PASSWORD", "replace-me-with-a-shared-password"],
    ["ADMIN_TOKEN", "short"],
    ["ADMIN_TOKEN", "replace-me-with-an-independent-admin-token"],
    ["ADMIN_TOKEN", password],
    ["ADMIN_TOKEN", sessionSecret],
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

  it.each([undefined, ""])("allows startup with an unset or empty ADMIN_TOKEN (%#)", (value) => {
    vi.stubEnv("ADMIN_TOKEN", value);
    expect(register).not.toThrow();
  });

  it.each([
    ["SESSION_SECRET", "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q"],
    ["SESSION_SECRET", "q-w-e-r-t-y-u-i-o-p-a-s-d-f-g-h-j"],
    ["SESSION_SECRET", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"],
    ["SESSION_SECRET", "V6*sW+2Q@12345678~pN9!uY=4H#LjX3B"],
    ["ACCESS_PASSWORD", "V6*sW+2Q@zyxwvuts~pN9!uY=4H#Lj"],
    ["ADMIN_TOKEN", "V6*sW+2Q@89abcdef~pN9!uY=4H#LjX3B"],
    ["ACCESS_PASSWORD", "V6*sW+2Q@3edc4rfv~pN9!uY=4H#Lj"],
    ["ADMIN_TOKEN", "V6*sW+2Q@iuytrewq~pN9!uY=4H#LjX3B"],
    ["ADMIN_TOKEN", "V6*sW+2Q@3_e d-c4_r f-v~pN9!uY=4H#Lj"],
    ["SESSION_SECRET", "V6*sW+2Q@ABCDEFGH~pN9!uY=4H#LjX3B"],
    ["ACCESS_PASSWORD", "V6*sW+2Q@QWERTYUI~pN9!uY=4H#Lj"],
    ["ADMIN_TOKEN", "V6*sW+2Q@A1B2C3D4E5F6G7H8~pN9!uY=4H#Lj"],
    ["SESSION_SECRET", "V6*sW+2Q@adgjmpsv~pN9!uY=4H#LjX3B"],
    ["SESSION_SECRET", "V6*sW+2Q@vspmjgda~pN9!uY=4H#LjX3B"],
    ["ACCESS_PASSWORD", "V6*sW+2Q@03692581~pN9!uY=4H#LjX3B"],
    ["ACCESS_PASSWORD", "V6*sW+2Q@0369cfil~pN9!uY=4H#LjX3B"],
    ["ADMIN_TOKEN", "V6*sW+2Q@aeimquy2~pN9!uY=4H#LjX3B"],
    ["SESSION_SECRET", "V6*sW+2Q@aX9dX9gX9jX9mX9pX9sX9v~pN9"],
    ["ACCESS_PASSWORD", "V6*sW+2Q@a12b12c12d12e12f12g12h12~pN9"],
    ["SESSION_SECRET", "V6*sW+2Q@a!d9g@j8m#p7s%v~pN9!uY=4H#LjX3B"],
    ["SESSION_SECRET", "V6*sW+2Q@a!?dX!gX9j!?m!Bp!@sX9v~pN9!uY=4H#LjX3B"],
    ...["9abcdef0", "bcdef012", "f0123456", "xyzabcde", "edcbazyx", "acegikmo", "vafkpuze"].map(
      (run) => ["SESSION_SECRET", `V6*sW+2Q@${run}~pN9!uY=4H#LjX3B`],
    ),
  ])("rejects predictable credential forms in %s (%#)", (name, value) => {
    vi.stubEnv(name, value);
    expect(register).toThrow(startupHalt);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(name));
  });

  const generatedSequences = [
    ["decimal", "0123456789"],
    ["hexadecimal", "0123456789abcdef"],
    ["alphabet", "abcdefghijklmnopqrstuvwxyz"],
    ["alphanumeric", "abcdefghijklmnopqrstuvwxyz0123456789"],
    ["keyboard rows", "qwertyuiopasdfghjklzxcvbnm"],
    ["keyboard columns", "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p"],
  ].flatMap(([family, ring]) => {
    const cases = [];
    const filler = ["m3p7s9v2", "K8zR6c5t"];
    const formats = [
      { format: "plain", separator: "", mixedCase: false },
      { format: "mixed case", separator: "", mixedCase: true },
      { format: "separated", separator: "-_ ", mixedCase: false },
      { format: "separated and mixed case", separator: "-_ ", mixedCase: true },
    ];
    for (const step of [1, -1, 2, -2, 3, -3, 4, 5]) {
      const starts = [{ topology: "wrapped", start: step > 0 ? ring.length - 1 : 0 }];
      // Eight characters span seven differences, which may require wrapping on short rings.
      if (7 * Math.abs(step) < ring.length) {
        starts.push({ topology: "unwrapped", start: step > 0 ? 0 : ring.length - 1 });
      }
      for (const { topology, start } of starts) {
        const run = Array.from({ length: 8 }, (_, index) =>
          ring[(start + step * index + ring.length * 3) % ring.length],
        );
        for (let stride = 1; stride <= 3; stride++) {
          for (let offset = 0; offset < stride; offset++) {
            const track = run.flatMap((char, index) => {
              const padding = filler.slice(0, stride - 1).map((lane) => lane[index]);
              padding.splice(offset, 0, char);
              return padding;
            });
            for (const { format, separator, mixedCase } of formats) {
              const sequence = track
                .map((char, index) => mixedCase && Math.floor(index / stride) % 2 === 0 ? char.toUpperCase() : char)
                .join(separator);
              const value = `V6*sW+2Q@${sequence}~pN9!uY=4H#LjX3B`;
              cases.push({ family, step, topology, stride, offset, format, value });
            }
          }
        }
      }
    }
    return cases;
  });

  it.each(generatedSequences)(
    "rejects $family sequences (step $step, $topology, stride $stride, offset $offset, $format)",
    ({ value }) => {
      vi.stubEnv("SESSION_SECRET", value);
      expect(register).toThrow(startupHalt);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("SESSION_SECRET"));
    },
  );

  it.each(["abcefgik", "abcdefgi", "aaaaaabb", "aaaaaaaa"])(
    "accepts a run without constant nonzero differences (%s)",
    (run) => {
      vi.stubEnv("SESSION_SECRET", `V6*sW+2Q@${run}~pN9!uY=4H#LjX3B`);
      expect(register).not.toThrow();
    },
  );

  it.each(["1234567", "zyxwvut", "89abcde", "3edc4rf", "iuytrew", "9abcdef", "xyzabcd", "acegikm"])(
    "accepts a seven-character sequence %s",
    (sequence) => {
      vi.stubEnv("SESSION_SECRET", `V6*sW+2Q@${sequence}~pN9!uY=4H#Lj+3B`);
      expect(register).not.toThrow();
    },
  );

  it("allows independently generated random hexadecimal credentials", () => {
    expect(register).not.toThrow();
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

  it("halts production public startup with a weak ADMIN_TOKEN and closes protected paths", async () => {
    vi.stubEnv("PRIVATE_MODE", "false");
    vi.stubEnv("ADMIN_TOKEN", "short");
    expect(register).toThrow(startupHalt);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ADMIN_TOKEN"));
    expect((await middleware(new NextRequest(`${origin}/api/models`))).status).toBe(503);
  });

  it.each(["short", undefined])("validates ADMIN_TOKEN during development public startup (%#)", async (value) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PRIVATE_MODE", "false");
    vi.stubEnv("ACCESS_PASSWORD", undefined);
    vi.stubEnv("SESSION_SECRET", undefined);
    vi.stubEnv("ADMIN_TOKEN", value);
    vi.resetModules();
    const startup = import("@/instrumentation");
    if (value) {
      await expect(startup).rejects.toThrow(startupHalt);
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ADMIN_TOKEN"));
    } else {
      await expect(startup).resolves.toHaveProperty("register");
      expect(process.exit).not.toHaveBeenCalled();
    }
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

  it.each([["payload", 0], ["signature", 1]] as const)("rejects a session with a tampered %s", async (_name, index) => {
    const parts = (await createSessionToken()).split(".");
    const segment = parts[index];
    parts[index] = `${segment[0] === "A" ? "B" : "A"}${segment.slice(1)}`;
    const token = parts.join(".");
    expect(await verifySessionToken(token)).toEqual({ valid: false });
    const request = new NextRequest(`${origin}/api/models`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect((await middleware(request)).status).toBe(401);
  });

  it.each(["", "abc", "a.b.c", `a.${"A".repeat(44)}`])("rejects a malformed session (%#)", async (token) => {
    expect(await verifySessionToken(token)).toEqual({ valid: false });
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

  it.each([
    "/login", "/login/", "/login//", "/login/extra", "/login;", "/login%3bparam/extra",
    "/api", "/api?x=1", "/api;param", "/api/auth/logout", "/api/models", "/%61pi/models",
    "/%6cogin", "/%6Cogin/", "/login%2f", "/api%2fmodels",
    "/login%5cextra", "/api%5cmodels", "/login\\extra", "/api\\models",
  ])(
    "falls back to the homepage for a login or API return path %s",
    (path) => expect(getLoginReturnPath(path)).toBe("/"),
  );

  it.each([null, "", "https://other.example/settings", "//evil.example/x", "/\\evil.example", "/%2f%2fevil.example", "/%5cevil.example"])(
    "falls back to the homepage for an invalid return path %s",
    (path) => expect(getLoginReturnPath(path)).toBe("/"),
  );

  it.each(["/settings?tab=x", "/login%3fnext", "/login-help", "/apiary"])(
    "preserves an allowed internal path %s",
    (path) => expect(getLoginReturnPath(path)).toBe(path),
  );

  it("delays each failed password attempt and never sets a cookie", async () => {
    vi.stubEnv("ACCESS_PASSWORD", `${password}\uFFFD`);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      for (const [index, value] of ["incorrect", password, `${password}\uD800`].entries()) {
        const response = await expectCredentialDelay(login(loginRequest(value)), 300 + 100 * index, 401);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a login body over the byte limit before issuing a cookie", async () => {
    const response = await login(loginRequest("多".repeat(1500)));
    expect(response.status).toBe(413);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it.each([
    ["a valid password split across chunks", 0, 200],
    ["exactly 4096 bytes", 4096, 200],
    ["4097 bytes", 4097, 413],
  ] as const)("handles a streamed login with %s", async (_description, byteLength, status) => {
    const json = JSON.stringify({ password });
    const body = new TextEncoder().encode(json.padEnd(byteLength, " "));
    if (byteLength) expect(body.byteLength).toBe(byteLength);
    const response = await login(streamedLoginRequest(body));
    expect(response.status).toBe(status);
    expect(response.cookies.has(SESSION_COOKIE_NAME)).toBe(status === 200);
    if (status === 413) expect(response.headers.has("set-cookie")).toBe(false);
  });
});

describe("public reads when PRIVATE_MODE=false", () => {
  beforeEach(() => vi.stubEnv("PRIVATE_MODE", "false"));

  it.each(["/compare", "/api/models"])("allows anonymous requests to %s", async (path) => {
    const response = await middleware(new NextRequest(`${origin}${path}`));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each(["arbitrary password", undefined])("allows public login without issuing a cookie (%#)", async (value) => {
    const request = value === undefined
      ? new Request(`${origin}/api/auth/login`, { method: "POST" })
      : loginRequest(value);
    const response = await login(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, privateMode: false });
    expect(response.headers.has("set-cookie")).toBe(false);
  });
});

describe.each([
  { name: "login", post: login, request: loginRequest, valid: password, denied: 401 },
  { name: "sync", post: sync, request: syncRequest, valid: adminToken, denied: 403 },
])("$name credential rate limiting", ({ post, request, valid, denied }) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    vi.mocked(runSyncJob).mockResolvedValue(syncResult);
  });

  afterEach(() => vi.useRealTimers());

  it("counts concurrent failures by the trusted last hop before any delay completes", async () => {
    vi.stubEnv("TRUST_PROXY", "true");
    const source = "192.0.2.1";
    const responses = vi.fn<(response: Response) => void>();
    const pending = Array.from({ length: 5 }, (_, index) =>
      post(request("incorrect", `198.51.100.${index + 1}, ${source}`)).then((response) => {
        responses(response);
        return response;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(299);
    expect(responses).not.toHaveBeenCalled();
    for (let completed = 1; completed <= pending.length; completed++) {
      await vi.advanceTimersByTimeAsync(completed === 1 ? 1 : 100);
      expect(responses).toHaveBeenCalledTimes(completed);
      expect(responses).toHaveBeenLastCalledWith(expect.objectContaining({ status: denied }));
    }
    await Promise.all(pending);
    await expectCredentialDelay(post(request("incorrect", `198.51.100.1, 192.0.2.2`)), 300, denied);
    vi.mocked(Date.now).mockReturnValue(testTime + 59_999);
    await expectCredentialDelay(post(request("incorrect", source)), 800, denied);
    vi.mocked(Date.now).mockReturnValue(testTime + 60_000);
    await expectCredentialDelay(post(request("incorrect", source)), 400, denied);
  });

  it("accepts valid credentials after five failures without X-Forwarded-For", async () => {
    for (let index = 0; index < 5; index++) {
      await expectCredentialDelay(post(request("incorrect")), 300 + 100 * index, denied);
    }
    const response = await post(request(valid));
    expect(response.status).toBe(200);
    if (post === login) {
      expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
    } else {
      expect(runSyncJob).toHaveBeenCalledExactlyOnceWith({ manual: true });
    }
    await expectCredentialDelay(post(request("incorrect")), 800, denied);
  });
});

describe("shared credential failure delays", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it.each([undefined, "false"])(
    "keeps rotating X-Forwarded-For entries in a single source bucket with TRUST_PROXY=%s",
    async (trustProxy) => {
      vi.stubEnv("TRUST_PROXY", trustProxy);
      for (const [index, address] of [undefined, "198.51.100.1", "198.51.100.2", "198.51.100.3"].entries()) {
        await expectCredentialDelay(login(loginRequest("incorrect", address)), 300 + 100 * index, 401);
      }
      await expectCredentialDelay(sync(syncRequest("incorrect", "198.51.100.4")), 700, 403);
    },
  );

  it("groups missing and invalid last hops when the proxy is trusted", async () => {
    vi.stubEnv("TRUST_PROXY", "true");
    await expectCredentialDelay(sync(syncRequest("incorrect", "198.51.100.1, invalid")), 300, 403);
    await expectCredentialDelay(sync(syncRequest("incorrect")), 400, 403);
    await expectCredentialDelay(sync(syncRequest("incorrect", "198.51.100.1")), 300, 403);
  });

  it("caps global failure delays across rotating sources and lets the operator sync immediately", async () => {
    vi.stubEnv("TRUST_PROXY", "true");
    vi.mocked(runSyncJob).mockResolvedValue(syncResult);
    for (let index = 1; index <= 46; index++) {
      const address = `198.51.100.${index}`;
      const delay = 300 + 100 * Math.max(0, index - 30);
      if (index % 2 === 0) {
        await expectCredentialDelay(sync(syncRequest("incorrect", address)), delay, 403);
      } else {
        await expectCredentialDelay(login(loginRequest("incorrect", address)), delay, 401);
      }
    }
    const cappedFailure = sync(syncRequest("incorrect", "198.51.100.47"));
    const response = await sync(syncRequest(adminToken, "198.51.100.47"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(syncResult);
    expect(runSyncJob).toHaveBeenCalledExactlyOnceWith({ manual: true });
    expect((await login(loginRequest(password, "198.51.100.47"))).cookies.has(SESSION_COOKIE_NAME)).toBe(true);
    await expectCredentialDelay(cappedFailure, 2_000, 403);
    await expectCredentialDelay(sync(syncRequest("incorrect", "198.51.100.48")), 2_000, 403);
    vi.mocked(Date.now).mockReturnValue(testTime + 60_000);
    await expectCredentialDelay(sync(syncRequest("incorrect", "198.51.100.48")), 300, 403);
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

  it.each([undefined, "", "short", "replace-me-with-an-independent-admin-token", password, sessionSecret])("disables sync when the admin credential is unavailable, weak, or reused (%#)", async (value) => {
    vi.stubEnv("ADMIN_TOKEN", value);
    const request = new Request(`${origin}/api/admin/sync`, {
      method: "POST",
      headers: { "x-admin-token": value || adminToken },
    });
    expect((await sync(request)).status).toBe(403);
    expect(runSyncJob).not.toHaveBeenCalled();
  });

  it("distinguishes a surrogate from U+FFFD in the admin credential comparison", async () => {
    vi.stubEnv("ADMIN_TOKEN", `${adminToken}\uFFFD`);
    const request = syncRequest(adminToken);
    // Fetch headers only accept ByteString, so supply the code units at the handler boundary.
    const getHeader = request.headers.get.bind(request.headers);
    vi.spyOn(request.headers, "get").mockImplementation((name) =>
      name === "x-admin-token" ? `${adminToken}\uD800` : getHeader(name),
    );
    expect((await sync(request)).status).toBe(403);
    expect(runSyncJob).not.toHaveBeenCalled();
  });

  it.each([
    ["success", 200],
    ["skipped_cooldown", 429],
    ["skipped_locked", 409],
    ["failed", 502],
  ] as const)("authorizes the operator and preserves %s as %i", async (status, httpStatus) => {
    const result = { ...syncResult, status };
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
