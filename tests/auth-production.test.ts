import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { expect, it } from "vitest";

const hasBuild = existsSync(".next/BUILD_ID");

// Run after npm run build. The flag makes a missing build fail in verification runs.
it.skipIf(!hasBuild && process.env.MODEL_COMPASS_TEST_PRODUCTION !== "1")(
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
