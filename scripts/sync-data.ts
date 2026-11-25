import { runSyncJob } from "../lib/sync/engine";

async function main() {
  const result = await runSyncJob({ manual: false });
  console.log("[sync:data] Completed:", JSON.stringify(result, null, 2));
  if (result.status === "failed") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[sync:data] Fatal error:", err);
  process.exit(1);
});
