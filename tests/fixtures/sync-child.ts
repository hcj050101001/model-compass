/**
 * Child-process fixture for tests/sync-publication.test.ts. Runs in a
 * real separate Node process (spawned with `node --import tsx`) against
 * the DATABASE_URL / MODEL_COMPASS_DATA_DIR given in its environment.
 *
 * Modes:
 *   acquire-hold <owner> <holdMs>  acquire the sync lease, print
 *                                  {"acquired":bool}, hold, then release.
 *   sync-demo                      run one demo sync, print the result.
 *   sync-real                      run one real sync, print the result.
 */
import { ensureSchema } from "../../lib/database";
import {
  acquireSyncLease,
  releaseSyncLease,
} from "../../lib/sync/lease";
import { runSyncJob } from "../../lib/sync/engine";

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  await ensureSchema();

  if (mode === "acquire-hold") {
    const [owner, holdMsRaw] = rest;
    const acquired = await acquireSyncLease(owner);
    console.log(JSON.stringify({ owner, acquired }));
    if (acquired) {
      await new Promise((resolve) =>
        setTimeout(resolve, Number.parseInt(holdMsRaw ?? "0", 10))
      );
      await releaseSyncLease(owner);
    }
    return;
  }

  if (mode === "sync-demo" || mode === "sync-real") {
    const result = await runSyncJob(
      mode === "sync-demo" ? { forceDemo: true } : { manual: false }
    );
    console.log(JSON.stringify(result));
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
