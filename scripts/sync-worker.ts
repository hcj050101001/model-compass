import { eq } from "drizzle-orm";
import { ensureSchema, getDb } from "../lib/database";
import { dataSnapshots } from "../lib/database/schema";
import { getAuthConfigError } from "../lib/auth-config";
import { runSyncJob, type SyncRunResult } from "../lib/sync/engine";
import { getSyncIntervalMinutes } from "../lib/ops/sync-config";

/**
 * The single production scheduler (Package F). It is the only process
 * that runs periodic syncs; the GitHub workflow is a gated distribution
 * path, not a site scheduler, and the web process never schedules.
 *
 * Behaviour:
 *  - Startup reuses the auth-config gate and requires the AA key in real
 *    mode (the same preflight the bootstrap CLI performs) before any
 *    sync attempt; schema is ensured once here (single-process
 *    migration entry is `npm run db:migrate` in the deploy sequence).
 *  - The next run is scheduled from the active snapshot's last verified
 *    fetch + DATA_SYNC_INTERVAL_MINUTES (the same config value the
 *    status page displays). An overdue snapshot triggers at most one
 *    catch-up run; the worker never burst-retries.
 *  - Each run goes through the engine's atomic lease, so a manual sync
 *    racing the worker results in exactly one execution.
 *  - SIGTERM/SIGINT stop new scheduling; an in-flight run finishes (the
 *    lease protects consistency if the process is hard-killed).
 */

let stopping = false;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ event, ts: new Date().toISOString(), ...fields })
  );
}

async function lastVerifiedFetchAt(): Promise<Date | null> {
  const db = getDb();
  const [snap] = await db
    .select()
    .from(dataSnapshots)
    .where(eq(dataSnapshots.status, "active"));
  if (!snap?.lastVerifiedFetchAt) return null;
  const parsed = new Date(snap.lastVerifiedFetchAt);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function runOnce(trigger: string): Promise<SyncRunResult> {
  const started = Date.now();
  const result = await runSyncJob({ manual: false });
  log("sync_run", {
    trigger,
    job_id: result.jobId,
    outcome: result.status,
    reason_code: result.reasonCode ?? null,
    snapshot_id: result.snapshotId ?? null,
    duration_ms: Date.now() - started,
  });
  return result;
}

async function main(): Promise<void> {
  const authError = getAuthConfigError();
  if (authError) {
    log("worker_preflight_failed", { reason_code: "auth_config_invalid" });
    console.error(`[sync-worker] ${authError}`);
    process.exit(1);
  }
  if (
    process.env.DEMO_MODE !== "true" &&
    !(process.env.AA_API_KEY?.trim() ?? "")
  ) {
    log("worker_preflight_failed", { reason_code: "missing_api_key" });
    console.error(
      "[sync-worker] AA_API_KEY is required in real mode; refusing to schedule."
    );
    process.exit(1);
  }

  await ensureSchema();
  const intervalMinutes = getSyncIntervalMinutes();
  log("worker_started", { sync_interval_minutes: intervalMinutes });

  process.on("SIGTERM", () => {
    stopping = true;
    log("worker_stopping", { signal: "SIGTERM" });
  });
  process.on("SIGINT", () => {
    stopping = true;
    log("worker_stopping", { signal: "SIGINT" });
  });

  while (!stopping) {
    const verifiedAt = await lastVerifiedFetchAt();
    const now = Date.now();
    let delayMs: number;
    if (!verifiedAt) {
      // No verified snapshot yet: the bootstrap fill is an operator step
      // (preflight → migrate → sync:data → snapshot:verify). The worker
      // waits one interval rather than racing the bootstrap.
      delayMs = intervalMinutes * 60_000;
      log("worker_waiting_for_bootstrap", { delay_ms: delayMs });
    } else {
      const nextDue = verifiedAt.getTime() + intervalMinutes * 60_000;
      delayMs = Math.max(0, nextDue - now);
    }

    if (delayMs > 0) {
      const wakeAt = new Date(now + delayMs).toISOString();
      log("worker_scheduled", { next_run_at: wakeAt, delay_ms: delayMs });
      const sleepEnd = Date.now() + delayMs;
      while (!stopping && Date.now() < sleepEnd) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1000, sleepEnd - Date.now()))
        );
      }
      if (stopping) break;
    }

    await runOnce("scheduled");
  }

  log("worker_stopped");
}

main().catch((err) => {
  console.error(
    "[sync-worker] Fatal error:",
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
