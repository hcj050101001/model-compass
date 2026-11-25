import { runSyncJob } from "../lib/sync/engine";

/**
 * Bootstrap/CI sync CLI (Package E): only `success` and `no_change` count
 * as success (exit 0). Failures exit 1; skipped states (lock conflict,
 * cooldown) are reported separately with exit 2 — never as success.
 */
async function main() {
  const result = await runSyncJob({ manual: false });
  console.log("[sync:data] Completed:", JSON.stringify(result, null, 2));
  if (result.status === "success" || result.status === "no_change") {
    process.exit(0);
  }
  if (
    result.status === "skipped_locked" ||
    result.status === "skipped_cooldown"
  ) {
    console.error(
      `[sync:data] Skipped (${result.reasonCode ?? result.status}); not a successful sync.`
    );
    process.exit(2);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("[sync:data] Fatal error:", err);
  process.exit(1);
});
