import { ensureSchema } from "./index";

async function main() {
  await ensureSchema();
  console.log("[db:migrate] Database schema verified and up to date.");
}

main().catch((err) => {
  console.error("[db:migrate] Migration failed:", err);
  process.exit(1);
});
