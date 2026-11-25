import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, "..");
const childScript = path.join(repoRoot, "tests/fixtures/sync-child.ts");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-pub-"));
const dataDir = path.join(tmpRoot, "data");
fs.mkdirSync(dataDir, { recursive: true });
const dbUrl = `file:${path.join(tmpRoot, "frontier.db")}`;

process.env.DATABASE_URL = dbUrl;
process.env.MODEL_COMPASS_DATA_DIR = dataDir;
delete process.env.AA_API_KEY;
delete process.env.DEMO_MODE;

// Modules are imported dynamically after env is set: the DB client reads
// DATABASE_URL lazily, but keep the ordering explicit.
let engine: typeof import("@/lib/sync/engine");
let lease: typeof import("@/lib/sync/lease");
let dbModule: typeof import("@/lib/database");
let schema: typeof import("@/lib/database/schema");
let exported: typeof import("@/lib/sync/standardized-export");

beforeAll(async () => {
  engine = await import("@/lib/sync/engine");
  lease = await import("@/lib/sync/lease");
  dbModule = await import("@/lib/database");
  schema = await import("@/lib/database/schema");
  exported = await import("@/lib/sync/standardized-export");
  await dbModule.ensureSchema();
}, 60_000);

async function runChild(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx", childScript, ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        MODEL_COMPASS_DATA_DIR: dataDir,
        ...env,
      },
      timeout: 120_000,
    }
  );
}

function lastJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

describe("ADR-7 atomic lease", () => {
  it("two real processes contend: exactly one acquires", async () => {
    const ownerA = `proc_a_${Date.now()}`;
    const ownerB = `proc_b_${Date.now()}`;
    const [a, b] = await Promise.all([
      runChild(["acquire-hold", ownerA, "3000"]),
      runChild(["acquire-hold", ownerB, "3000"]),
    ]);
    const results = [lastJsonLine(a.stdout), lastJsonLine(b.stdout)];
    const acquired = results.filter((r) => r.acquired === true);
    expect(acquired).toHaveLength(1);
  }, 60_000);

  it("expired takeover: old owner cannot renew or delete the new lock", async () => {
    const oldOwner = `old_${Date.now()}`;
    const newOwner = `new_${Date.now()}`;
    process.env.SYNC_LOCK_TTL_SECONDS = "1";
    expect(await lease.acquireSyncLease(oldOwner)).toBe(true);
    expect(await lease.acquireSyncLease(newOwner)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    process.env.SYNC_LOCK_TTL_SECONDS = "60";
    expect(await lease.acquireSyncLease(newOwner)).toBe(true);
    // Old owner is locked out of every lease operation on the new lock.
    expect(await lease.renewSyncLease(oldOwner)).toBe(false);
    await lease.releaseSyncLease(oldOwner);
    expect(await lease.isSyncLeaseHeld(newOwner)).toBe(true);
    expect(await lease.renewSyncLease(newOwner)).toBe(true);
    await lease.releaseSyncLease(newOwner);
    expect(await lease.isSyncLeaseHeld(newOwner)).toBe(false);
    delete process.env.SYNC_LOCK_TTL_SECONDS;
  }, 30_000);
});

describe("publication flow (demo entry, offline)", () => {
  it("publishes a complete version: DB record, immutable file, job terminal in one activation", async () => {
    const result = await engine.runSyncJob({ forceDemo: true });
    expect(result.status).toBe("success");
    expect(result.snapshotId).toBeTruthy();

    const db = dbModule.getDb();
    const [snap] = await db
      .select()
      .from(schema.dataSnapshots)
      .where(eq(schema.dataSnapshots.id, result.snapshotId as string));
    expect(snap.status).toBe("active");
    expect(snap.publishedAt).toBeTruthy();
    expect(Number.isFinite(Date.parse(snap.publishedAt as string))).toBe(true);
    expect(snap.fileGeneratedAt).toBeTruthy();
    // AA/demo expose no trustworthy upstream timestamp: null, not backfilled.
    expect(snap.sourceDataAt).toBeNull();
    expect(snap.exportPath).toBe(`snapshots/${snap.id}.json`);
    expect(snap.lastVerifiedFetchAt).toBe(snap.fetchedAt);

    const bytes = exported.readPublicationFile(snap.exportPath as string);
    expect(bytes).not.toBeNull();
    expect(exported.sha256Hex(bytes as string)).toBe(snap.exportSha256);
    const payload = JSON.parse(bytes as string) as {
      snapshot_id: string;
      generated_at: string;
    };
    expect(payload.snapshot_id).toBe(snap.id);
    expect(payload.generated_at).toBe(snap.fileGeneratedAt);

    const [job] = await db
      .select()
      .from(schema.syncJobs)
      .where(eq(schema.syncJobs.id, result.jobId));
    expect(job.status).toBe("success");
    expect(job.snapshotId).toBe(snap.id);

    // Distribution copies carry exactly the publication bytes.
    const mainBytes = fs.readFileSync(
      path.join(dataDir, "standardized-models.json"),
      "utf8"
    );
    expect(mainBytes).toBe(bytes);
  }, 120_000);

  it("no_change preserves snapshot id, publication/generated times and export bytes", async () => {
    const db = dbModule.getDb();
    const [before] = await db
      .select()
      .from(schema.dataSnapshots)
      .where(eq(schema.dataSnapshots.status, "active"));
    const bytesBefore = exported.readPublicationFile(
      before.exportPath as string
    );

    const result = await engine.runSyncJob({ forceDemo: true });
    expect(result.status).toBe("no_change");
    expect(result.snapshotId).toBe(before.id);

    const [after] = await db
      .select()
      .from(schema.dataSnapshots)
      .where(eq(schema.dataSnapshots.id, before.id));
    expect(after.publishedAt).toBe(before.publishedAt);
    expect(after.fileGeneratedAt).toBe(before.fileGeneratedAt);
    expect(
      exported.readPublicationFile(after.exportPath as string)
    ).toBe(bytesBefore);
    // Only the verification clock advanced.
    expect(
      Date.parse(after.lastVerifiedFetchAt as string)
    ).toBeGreaterThanOrEqual(Date.parse(before.lastVerifiedFetchAt as string));
  }, 120_000);

  it("stranded running jobs are marked failed + interrupted on takeover", async () => {
    const db = dbModule.getDb();
    const strandedId = `job_stranded_${Date.now()}`;
    await db.insert(schema.syncJobs).values({
      id: strandedId,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      status: "running",
      fetchedCount: 0,
      validCount: 0,
      rejectedCount: 0,
      owner: "dead_owner",
    });
    const result = await engine.runSyncJob({ forceDemo: true });
    expect(["success", "no_change"]).toContain(result.status);
    const [stranded] = await db
      .select()
      .from(schema.syncJobs)
      .where(eq(schema.syncJobs.id, strandedId));
    expect(stranded.status).toBe("failed");
    expect(stranded.reasonCode).toBe("interrupted");
  }, 120_000);
});

describe("fault injection reconciliation", () => {
  it("fault after staging: no active version; retry publishes completely", async () => {
    const isoDir = path.join(tmpRoot, "fault-staging");
    fs.mkdirSync(isoDir, { recursive: true });
    const isoEnv = {
      DATABASE_URL: `file:${path.join(isoDir, "frontier.db")}`,
      MODEL_COMPASS_DATA_DIR: isoDir,
    };
    const failed = await runChild(["sync-demo"], {
      ...isoEnv,
      MODEL_COMPASS_FAULT_INJECT: "after_staging",
    });
    expect(lastJsonLine(failed.stdout).status).toBe("failed");

    const ok = await runChild(["sync-demo"], isoEnv);
    const okResult = lastJsonLine(ok.stdout);
    expect(okResult.status).toBe("success");
    const file = path.join(
      isoDir,
      "snapshots",
      `${okResult.snapshotId as string}.json`
    );
    expect(fs.existsSync(file)).toBe(true);
  }, 180_000);

  it("fault after activation: activation and job terminal state already committed together", async () => {
    const isoDir = path.join(tmpRoot, "fault-activation");
    fs.mkdirSync(isoDir, { recursive: true });
    const isoEnv = {
      DATABASE_URL: `file:${path.join(isoDir, "frontier.db")}`,
      MODEL_COMPASS_DATA_DIR: isoDir,
    };
    const crashed = await runChild(["sync-demo"], {
      ...isoEnv,
      MODEL_COMPASS_FAULT_INJECT: "after_activation",
    });
    // The child reports failure (distribution copy never ran), but the
    // activation transaction committed: a follow-up run reconciles via
    // no_change and repairs the distribution copies from verified bytes.
    expect(lastJsonLine(crashed.stdout).status).toBe("failed");
    expect(
      fs.existsSync(path.join(isoDir, "standardized-models.json"))
    ).toBe(false);

    const retry = await runChild(["sync-demo"], isoEnv);
    const retryResult = lastJsonLine(retry.stdout);
    expect(retryResult.status).toBe("no_change");
    const mainBytes = fs.readFileSync(
      path.join(isoDir, "standardized-models.json"),
      "utf8"
    );
    const versionBytes = fs.readFileSync(
      path.join(
        isoDir,
        "snapshots",
        `${retryResult.snapshotId as string}.json`
      ),
      "utf8"
    );
    expect(mainBytes).toBe(versionBytes);
  }, 180_000);
});

describe("data gates (real mode)", () => {
  it("empty DB without a key fails closed and writes no files", async () => {
    const isoDir = path.join(tmpRoot, "gate-nokey");
    fs.mkdirSync(isoDir, { recursive: true });
    const isoEnv = {
      DATABASE_URL: `file:${path.join(isoDir, "frontier.db")}`,
      MODEL_COMPASS_DATA_DIR: isoDir,
      AA_API_KEY: "",
      DEMO_MODE: "false",
    };
    const res = await runChild(["sync-real"], isoEnv);
    const result = lastJsonLine(res.stdout);
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("missing_api_key");
    expect(fs.existsSync(path.join(isoDir, "standardized-models.json"))).toBe(
      false
    );
    expect(fs.existsSync(path.join(isoDir, "snapshots"))).toBe(false);
  }, 120_000);

  it("AA 401 and 429 fail the sync with structured reason codes", async () => {
    const unauthorized = await engine.runSyncJob({
      forceDemo: false,
      aaFetchImpl: async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
        }),
    });
    // No key is configured in this test process, so the gate fires first;
    // configure a key and retry to reach the upstream classification.
    expect(unauthorized.status).toBe("failed");
    expect(unauthorized.reasonCode).toBe("missing_api_key");

    process.env.AA_API_KEY = "test-key-for-gate-matrix";
    try {
      const auth = await engine.runSyncJob({
        aaFetchImpl: async () =>
          new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
          }),
      });
      expect(auth.status).toBe("failed");
      expect(auth.reasonCode).toBe("upstream_auth");

      const limited = await engine.runSyncJob({
        aaFetchImpl: async () =>
          new Response(JSON.stringify({ error: "slow down" }), {
            status: 429,
            headers: { "Retry-After": "0" },
          }),
      });
      expect(limited.status).toBe("failed");
      expect(limited.reasonCode).toBe("upstream_rate_limited");
    } finally {
      delete process.env.AA_API_KEY;
    }
  }, 120_000);
});
