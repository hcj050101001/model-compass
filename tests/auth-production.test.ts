import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";

const buildIdPath = ".next/BUILD_ID";
const usesPrebuiltBundle = process.env.MODEL_COMPASS_TEST_PRODUCTION === "1";
const buildInputs = [
  "app", "components", "config", "lib", "public", "types",
  "instrumentation.ts", "middleware.ts", "next.config.ts", "postcss.config.mjs",
  "tailwind.config.ts", "tsconfig.json", "package.json", "package-lock.json",
  ".env", ".env.local", ".env.production", ".env.production.local",
];
let previousBuildId: string | undefined;

function findNewerBuildInput(path: string, builtAt: number): string | undefined {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return;
  if (stats.mtimeMs > builtAt) return path;
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) {
      const newerInput = findNewerBuildInput(join(path, entry), builtAt);
      if (newerInput) return newerInput;
    }
  }
}

beforeAll(async () => {
  if (usesPrebuiltBundle) {
    const buildId = statSync(buildIdPath, { throwIfNoEntry: false });
    if (!buildId) {
      throw new Error("Production build missing. Run npm run test:production.");
    }
    for (const input of buildInputs) {
      const newerInput = findNewerBuildInput(input, buildId.mtimeMs);
      if (newerInput) {
        throw new Error(`Production build is stale (${newerInput} is newer than ${buildIdPath}). Run npm run test:production to rebuild.`);
      }
    }
    return;
  }

  // Exercise replacement of an existing build ID even on a clean checkout.
  if (!existsSync(buildIdPath)) {
    mkdirSync(".next", { recursive: true });
    writeFileSync(buildIdPath, "stale-build-fixture", { flag: "wx" });
  }
  previousBuildId = readFileSync(buildIdPath, "utf8");
  await promisify(execFile)("npm", ["run", "build"], {
    env: { ...process.env, NODE_ENV: "production" },
    timeout: 240_000,
  });
}, 245_000);

it.skipIf(usesPrebuiltBundle)("replaces an existing build before testing current source", () => {
  expect(previousBuildId).toBeDefined();
  expect(readFileSync(buildIdPath, "utf8")).not.toBe(previousBuildId);
});

it(
  "emits a relative Location through next start with forwarded proto and host",
  async () => {
    const server = spawn(process.execPath, [
      require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "0",
    ], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        PRIVATE_MODE: "true",
        SESSION_SECRET: randomBytes(32).toString("hex"),
        ACCESS_PASSWORD: randomBytes(32).toString("hex"),
        ADMIN_TOKEN: randomBytes(32).toString("hex"),
      },
    });
    let output = "";
    let closed = false;
    const stopped = new Promise<void>((resolve) => {
      server.once("close", () => {
        closed = true;
        resolve();
      });
    });
    server.on("error", (error) => { output += `${error}\n`; });
    server.stdout.on("data", (chunk) => { output += String(chunk); });
    server.stderr.on("data", (chunk) => { output += String(chunk); });

    try {
      const deadline = Date.now() + 10_000;
      while (!closed && !output.includes("Ready in") && Date.now() < deadline) await wait(50);
      const origin = output.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (closed || !origin || !output.includes("Ready in")) {
        throw new Error(`next start did not become ready\n${output}`);
      }

      const response = await fetch(`${origin}/compare?model=a`, {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "model-compass.example:8443",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      const location = response.headers.get("location");
      await response.body?.cancel();
      expect(response.status).toBe(307);
      expect(location).toMatch(/^\/login\?next=/);
      expect(location).toBe("/login?next=%2Fcompare%3Fmodel%3Da");
      console.info(`next start returned HTTP ${response.status}, Location: ${location}`);
    } finally {
      server.kill("SIGKILL");
      await stopped;
    }
  },
  20_000,
);
