import { getActiveMeasurements } from "@/lib/database/queries";

/**
 * Two-process schema-immutability probe (Package B): a standalone process
 * that attempts a normal read against DATABASE_URL and prints the outcome.
 * The parent test asserts both processes fail with SchemaCompatibilityError
 * and that the database schema is byte-identical afterwards.
 */
async function main(): Promise<void> {
  try {
    await getActiveMeasurements();
    console.log("OK");
  } catch (err) {
    console.log(err instanceof Error ? err.name : "unknown-error");
  }
}

void main();
