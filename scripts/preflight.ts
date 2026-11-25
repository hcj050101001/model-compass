import fs from "node:fs";
import path from "node:path";
import { getAuthConfigError } from "../lib/auth-config";
import { getCoverageThresholds } from "../lib/sync/coverage";
import {
  getManualSyncCooldownSeconds,
  getMaxSnapshotAgeMinutes,
  getSyncIntervalMinutes,
} from "../lib/ops/sync-config";
import { getDataDir } from "../lib/sync/standardized-export";

/**
 * Deployment preflight (Package F): runs before any migration/bootstrap.
 * Verifies — without creating a database or writing publication data —
 * the auth configuration (reusing getAuthConfigError), the AA key
 * presence for real mode, an absolute local SQLite path, data-volume
 * writability (create/write/rename/remove probe as the service UID) and
 * the scheduling/coverage configuration. Prints reason codes only;
 * exit 0 = all checks pass.
 */

interface Check {
  name: string;
  ok: boolean;
  reason?: string;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, reason?: string): void {
  checks.push({ name, ok, reason });
}

function main(): void {
  // Auth configuration, exactly the startup gate's own validator.
  const authError = getAuthConfigError();
  record("auth_config", authError === undefined, authError ? "auth_config_invalid" : undefined);

  // Real mode requires the AA key before bootstrap (Package F: key
  // preflight completes before the first fill).
  const demoMode = process.env.DEMO_MODE === "true";
  const apiKey = process.env.AA_API_KEY?.trim() ?? "";
  record(
    "aa_api_key",
    demoMode || apiKey.length > 0,
    demoMode || apiKey.length > 0 ? undefined : "missing_api_key"
  );

  // DATABASE_URL must be an absolute local file: SQLite path.
  const rawDb = process.env.DATABASE_URL ?? "";
  let dbOk = false;
  let dbReason: string | undefined = "database_url_not_absolute_file";
  if (rawDb.startsWith("file:")) {
    const filePath = rawDb.slice("file:".length);
    if (path.isAbsolute(filePath)) {
      dbOk = true;
      dbReason = undefined;
    }
  }
  record("database_url", dbOk, dbReason);

  // Data volume writability probe in the publication root: create,
  // write, rename within the same directory, then remove. Leaves no
  // residue beyond directories the runtime itself needs.
  const dataDir = getDataDir();
  try {
    fs.mkdirSync(path.join(dataDir, "snapshots"), { recursive: true });
    const probe = path.join(dataDir, `.preflight-probe-${process.pid}.tmp`);
    const renamed = path.join(dataDir, `.preflight-probe-${process.pid}.renamed`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.renameSync(probe, renamed);
    fs.rmSync(renamed, { force: true });
    record("data_volume_writable", true);
  } catch {
    record("data_volume_writable", false, "data_volume_not_writable");
  }

  // Scheduling / freshness configuration sanity (single config source).
  const interval = getSyncIntervalMinutes();
  const cooldown = getManualSyncCooldownSeconds();
  const maxAge = getMaxSnapshotAgeMinutes();
  record(
    "sync_config",
    interval > 0 && cooldown > 0 && maxAge > interval * 2,
    interval > 0 && cooldown > 0 && maxAge > interval * 2
      ? undefined
      : "sync_config_invalid"
  );

  // Coverage thresholds must be positive integers (provisional values).
  try {
    const thresholds = getCoverageThresholds();
    record(
      "coverage_thresholds",
      thresholds.minScoredModels > 0 &&
        thresholds.minPositiveEstimateModels > 0,
      thresholds.minScoredModels > 0 &&
        thresholds.minPositiveEstimateModels > 0
        ? undefined
        : "coverage_thresholds_invalid"
    );
  } catch {
    record("coverage_thresholds", false, "coverage_thresholds_unreadable");
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(
    JSON.stringify(
      {
        status: failed.length === 0 ? "ok" : "failed",
        checks,
        config: {
          sync_interval_minutes: interval,
          manual_sync_cooldown_seconds: cooldown,
          max_snapshot_age_minutes: maxAge,
        },
      },
      null,
      2
    )
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
