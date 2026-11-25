import { getClient } from "@/lib/database";

/**
 * Atomic sync lease (Package E, design §2.6 / ADR-7).
 *
 * ADR-7 opening-fixture conclusion (2026-11-26, recorded in the T4 dev
 * report): the libsql driver supports the primary implementation — a
 * single-statement conditional upsert judged by its RETURNING rows, with
 * all timestamps produced by the database clock inside the same statement.
 * Two real processes contending on one file DB produced exactly one
 * winner; after expiry a new owner took over and the old owner could
 * neither renew nor delete the new lock. Notes from the fixture:
 * `rowsAffected` is 0 for a RETURNING statement, so acquisition MUST be
 * judged by the returned rows; concurrent writers need a busy timeout.
 * The ADR-7 same-transaction fallback is therefore not used.
 */

export const SYNC_LOCK_KEY = "global_data_sync";

/** DB-side UTC timestamp expression, ISO-8601 with millisecond precision. */
const DB_NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export function getSyncLockTtlSeconds(): number {
  const raw = process.env.SYNC_LOCK_TTL_SECONDS;
  const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 300;
}

async function withBusyTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const client = getClient();
  await client.execute(`PRAGMA busy_timeout = 5000;`);
  return fn();
}

/**
 * Single-statement conditional acquisition: insert, or take over only
 * when the existing lock has expired at the DB clock (`expires_at <= now`,
 * so a lock expiring exactly now is takeable). Returns true iff this
 * owner now holds the lock.
 */
export async function acquireSyncLease(owner: string): Promise<boolean> {
  const client = getClient();
  const ttl = getSyncLockTtlSeconds();
  return withBusyTimeout(async () => {
    const res = await client.execute({
      sql: `INSERT INTO sync_locks (lock_key, locked_at, expires_at, owner)
            VALUES (?, ${DB_NOW}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', ?)), ?)
            ON CONFLICT(lock_key) DO UPDATE SET
              locked_at = excluded.locked_at,
              expires_at = excluded.expires_at,
              owner = excluded.owner
            WHERE sync_locks.expires_at <= excluded.locked_at
            RETURNING owner`,
      args: [SYNC_LOCK_KEY, ttl, owner],
    });
    return res.rows.length === 1 && String(res.rows[0].owner) === owner;
  });
}

/**
 * Conditional renewal: only the current owner of an unexpired lock may
 * extend it. Returns false when the lease has been lost (expired or
 * taken over) — the caller must stop all writes immediately.
 */
export async function renewSyncLease(owner: string): Promise<boolean> {
  const client = getClient();
  const ttl = getSyncLockTtlSeconds();
  return withBusyTimeout(async () => {
    const res = await client.execute({
      sql: `UPDATE sync_locks
            SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', ?))
            WHERE lock_key = ? AND owner = ? AND expires_at > ${DB_NOW}
            RETURNING owner`,
      args: [ttl, SYNC_LOCK_KEY, owner],
    });
    return res.rows.length === 1 && String(res.rows[0].owner) === owner;
  });
}

/** Release only ever deletes the caller's own lock row. */
export async function releaseSyncLease(owner: string): Promise<void> {
  const client = getClient();
  await client.execute({
    sql: `DELETE FROM sync_locks WHERE lock_key = ? AND owner = ?`,
    args: [SYNC_LOCK_KEY, owner],
  });
}

/** True iff `owner` currently holds an unexpired lease (DB clock). */
export async function isSyncLeaseHeld(owner: string): Promise<boolean> {
  const client = getClient();
  const res = await client.execute({
    sql: `SELECT owner FROM sync_locks
          WHERE lock_key = ? AND owner = ? AND expires_at > ${DB_NOW}`,
    args: [SYNC_LOCK_KEY, owner],
  });
  return res.rows.length === 1;
}
