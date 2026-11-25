import { NextResponse } from "next/server";
import { desc, inArray } from "drizzle-orm";
import { assertSchemaCompatible, getDb, SchemaCompatibilityError } from "@/lib/database";
import { dataSnapshots } from "@/lib/database/schema";

export async function GET() {
  try {
    await assertSchemaCompatible();
  } catch (err) {
    if (err instanceof SchemaCompatibilityError) {
      // Desensitized: never echo the underlying schema error text.
      return NextResponse.json(
        { error: "service_unavailable", reason: "schema_incompatible" },
        { status: 503 }
      );
    }
    throw err;
  }
  const db = getDb();
  // History only lists published (active) or archived snapshots.
  const snapshots = await db
    .select()
    .from(dataSnapshots)
    .where(inArray(dataSnapshots.status, ["active", "archived"]))
    .orderBy(desc(dataSnapshots.fetchedAt))
    .limit(50);

  return NextResponse.json({ snapshots });
}
