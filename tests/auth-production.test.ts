import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFingerprintPath, buildInputs, getBuildFingerprint } from "../scripts/record-build-fingerprint.mjs";

const buildIdPath = ".next/BUILD_ID";
const usesPrebuiltBundle = process.env.MODEL_COMPASS_TEST_PRODUCTION === "1";
let previousBuildId: string | undefined;

// Freshness is judged by content fingerprint only: the fingerprint recorded
// by postbuild (scripts/record-build-fingerprint.mjs) must equal the
// fingerprint of the current build inputs. Any added, deleted, or modified
// input — including a deleted top-level file the old mtime guard skipped —
// changes the fingerprint and marks the prebuilt bundle stale.
function assertPrebuiltFresh(): void {
  if (!existsSync(buildIdPath)) {
    throw new Error("Production build missing. Run npm run test:production.");
  }
  let recorded: unknown;
  try {
    recorded = (JSON.parse(readFileSync(buildFingerprintPath, "utf8")) as { fingerprint?: unknown }).fingerprint;
  } catch {
    recorded = undefined;
  }
  if (typeof recorded !== "string" || recorded !== getBuildFingerprint()) {
    throw new Error(
      `Production build is stale (recorded build fingerprint in ${buildFingerprintPath} does not match the current build inputs). Run npm run test:production to rebuild.`,
    );
  }
}

beforeAll(async () => {
  if (usesPrebuiltBundle) {
    assertPrebuiltFresh();
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

describe("build fingerprint freshness", () => {
  function makeInputFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "build-fingerprint-"));
    writeFileSync(join(root, "package.json"), "{}\n");
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "lib", "b.ts"), "export const b = 2;\n");
    return root;
  }

  it("changes the fingerprint when a build input is modified, added, or deleted", () => {
    const root = makeInputFixture();
    try {
      const original = getBuildFingerprint(root);

      // Modify an existing input file.
      writeFileSync(join(root, "lib", "a.ts"), "export const a = 99;\n");
      expect(getBuildFingerprint(root)).not.toBe(original);
      writeFileSync(join(root, "lib", "a.ts"), "export const a = 1;\n");
      expect(getBuildFingerprint(root)).toBe(original);

      // Add a new file inside a listed directory input.
      writeFileSync(join(root, "lib", "c.ts"), "export const c = 3;\n");
      expect(getBuildFingerprint(root)).not.toBe(original);
      rmSync(join(root, "lib", "c.ts"));
      expect(getBuildFingerprint(root)).toBe(original);

      // Delete a file inside a listed directory input.
      rmSync(join(root, "lib", "b.ts"));
      expect(getBuildFingerprint(root)).not.toBe(original);
      writeFileSync(join(root, "lib", "b.ts"), "export const b = 2;\n");
      expect(getBuildFingerprint(root)).toBe(original);

      // Add then delete a top-level file input (the old mtime guard silently
      // skipped missing paths, so deleting middleware.ts went undetected).
      expect(buildInputs).toContain("middleware.ts");
      writeFileSync(join(root, "middleware.ts"), "export {};\n");
      expect(getBuildFingerprint(root)).not.toBe(original);
      rmSync(join(root, "middleware.ts"));
      expect(getBuildFingerprint(root)).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The freshness check runs in beforeAll, before `next start` is spawned, so
  // a throw here is what guarantees no service starts on a stale bundle.
  it.skipIf(!usesPrebuiltBundle)(
    "rejects a tampered recorded fingerprint before any service starts and restores it",
    () => {
      const originalBytes = readFileSync(buildFingerprintPath, "utf8");
      const { fingerprint } = JSON.parse(originalBytes) as { fingerprint: string };
      const tampered = `${fingerprint[0] === "0" ? "1" : "0"}${fingerprint.slice(1)}`;
      try {
        writeFileSync(buildFingerprintPath, `${JSON.stringify({ fingerprint: tampered })}\n`);
        expect(() => assertPrebuiltFresh()).toThrow(/stale/);
      } finally {
        writeFileSync(buildFingerprintPath, originalBytes);
      }
      expect(readFileSync(buildFingerprintPath, "utf8")).toBe(originalBytes);
      expect(() => assertPrebuiltFresh()).not.toThrow();
    },
  );
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
