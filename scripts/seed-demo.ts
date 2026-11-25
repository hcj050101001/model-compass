import { runSyncJob } from "../lib/sync/engine";

async function main() {
  const result = await runSyncJob({ forceDemo: true });
  console.log("[seed:demo] Completed:", JSON.stringify(result, null, 2));
  if (result.status === "failed") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[seed:demo] Fatal error:", err);
  process.exit(1);
});
