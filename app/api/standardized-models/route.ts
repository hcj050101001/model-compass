import { NextResponse } from "next/server";
import { getActiveMeasurements } from "@/lib/database/queries";
import { toStandardizedRecord } from "@/lib/sync/standardized-export";
import {
  LEGACY_TEMPLATE_VERSION,
  MULTI_TURN_TEMPLATE_VERSION,
} from "@/lib/agent-cost/developer-cost";

export async function GET() {
  const { snapshot, rows } = await getActiveMeasurements();
  // Template version persisted per snapshot (Package D). Snapshots written
  // before the template-version column existed carry legacy derived values:
  // report them as the legacy fallback instead of inventing a version.
  const snapshotTemplateVersion =
    (snapshot as { templateVersion?: string | null } | null)
      ?.templateVersion ?? null;
  return NextResponse.json({
    schema_version: "2.0.0",
    snapshot_id: snapshot?.id ?? null,
    index_version: snapshot?.benchmarkVersion ?? null,
    is_demo: snapshot?.isDemo ?? true,
    cost_metadata: {
      snapshot_id: snapshot?.id ?? null,
      cost_mode: "eac",
      cost_unit: "USD/simulated task",
      task_profile: "standard",
      template_version: snapshotTemplateVersion ?? LEGACY_TEMPLATE_VERSION,
      current_template_version: MULTI_TURN_TEMPLATE_VERSION,
      template_version_source: snapshotTemplateVersion
        ? "snapshot"
        : "legacy_fallback",
      candidate_scope: "all",
    },
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
