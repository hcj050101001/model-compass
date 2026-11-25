/**
 * Single source of truth for sync scheduling / freshness configuration.
 *
 * `DATA_SYNC_INTERVAL_MINUTES` drives both the production worker's actual
 * schedule (scripts/sync-worker.ts) and the status page display
 * (lib/database/queries.ts) — no second default literal may exist elsewhere.
 * The freshness values are the Package F initial values (provisional,
 * pending the deployment owner's final confirmation): interval 60,
 * manual cooldown 120s, max snapshot age 1440 minutes.
 */

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getSyncIntervalMinutes(): number {
  return parsePositiveInt(process.env.DATA_SYNC_INTERVAL_MINUTES, 60);
}

export function getManualSyncCooldownSeconds(): number {
  return parsePositiveInt(process.env.MANUAL_SYNC_COOLDOWN_SECONDS, 120);
}

export function getMaxSnapshotAgeMinutes(): number {
  return parsePositiveInt(process.env.MAX_SNAPSHOT_AGE_MINUTES, 1440);
}
