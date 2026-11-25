import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { ensureSchema, getDb } from "@/lib/database";
import { dataSnapshots } from "@/lib/database/schema";

export async function GET() {
  await ensureSchema();
  const db = getDb();
  const snapshots = await db
    .select()
    .from(dataSnapshots)
    .orderBy(desc(dataSnapshots.fetchedAt))
    .limit(50);

  return NextResponse.json({ snapshots });
}
