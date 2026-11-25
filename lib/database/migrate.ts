import { runMigrations } from "./index";

async function main() {
  const { applied, version } = await runMigrations();
  if (applied.length > 0) {
    console.log(
      `[db:migrate] Applied migrations: ${applied.join(", ")} (schema version ${version}).`
    );
  } else {
    console.log(`[db:migrate] Database schema already up to date (version ${version}).`);
  }
}

main().catch((err) => {
  console.error("[db:migrate] Migration failed:", err);
  process.exit(1);
});
