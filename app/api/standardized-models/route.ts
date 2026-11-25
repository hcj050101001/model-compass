import { NextResponse } from "next/server";
import { getActiveMeasurements } from "@/lib/database/queries";
import { toStandardizedRecord } from "@/lib/sync/standardized-export";

export async function GET() {
  const { snapshot, rows } = await getActiveMeasurements();
  return NextResponse.json({
    schema_version: "2.0.0",
    snapshot_id: snapshot?.id ?? null,
    index_version: snapshot?.benchmarkVersion ?? null,
    is_demo: snapshot?.isDemo ?? true,
    updated_at: snapshot?.fetchedAt ?? null,
    models: rows.map(toStandardizedRecord),
  });
}
