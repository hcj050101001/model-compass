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
    // Four-time contract (Package E): updated_at keeps its legacy meaning
    // as the compatibility value = published_at (DB activation time);
    // legacy snapshots without a publication record fall back to
    // fetched_at until they are republished.
    updated_at: snapshot?.publishedAt ?? snapshot?.fetchedAt ?? null,
    fetched_at: snapshot?.fetchedAt ?? null,
    source_data_at: snapshot?.sourceDataAt ?? null,
    published_at: snapshot?.publishedAt ?? null,
    file_generated_at: snapshot?.fileGeneratedAt ?? null,
    models: rows.map(toStandardizedRecord),
  });
}
