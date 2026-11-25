import { desc, eq } from "drizzle-orm";
import { assertSchemaCompatible, getDb } from "./index";
import { getSyncIntervalMinutes } from "@/lib/ops/sync-config";
import {
  benchmarkMeasurements,
  dataSnapshots,
  modelCreators,
  modelReleases,
  modelVariants,
  syncJobs,
} from "./schema";
import type { MeasurementRow } from "@/lib/analytics/types";
import { calculateDeveloperAgentCost } from "@/lib/agent-cost/developer-cost";
import { classifyDataQuality } from "@/lib/agent-cost/quality";
import type {
  AgentCostSummary,
  AgentUsageSummary,
  DataQualityLevel,
  DataQualitySummary,
  DataSourceType,
} from "@/lib/agent-cost/types";
import {
  parseEffortAndRelease,
  type EffortLadderType,
} from "@/lib/normalization/effort";

export function canonicalizeMeasurementRows(
  rows: MeasurementRow[]
): MeasurementRow[] {
  const parsedByRow = rows.map((r) => {
    const parsed = parseEffortAndRelease({
      rawName: r.rawName,
      slug: r.sourceSlug,
    });
    const canonicalReleaseName = parsed.isGrouped
      ? parsed.baseName
      : r.releaseName;
    const groupKey = `${r.creatorSlug}::${canonicalReleaseName.toLowerCase()}`;
    return { row: r, parsed, canonicalReleaseName, groupKey };
  });

  const canonicalReleaseIdByGroup = new Map<string, string>();
  for (const item of parsedByRow) {
    const existing = canonicalReleaseIdByGroup.get(item.groupKey);
    if (!existing) {
      canonicalReleaseIdByGroup.set(item.groupKey, item.row.releaseId);
    } else if (item.row.releaseName === item.canonicalReleaseName) {
      canonicalReleaseIdByGroup.set(item.groupKey, item.row.releaseId);
    }
  }

  return parsedByRow.map(({ row, parsed, canonicalReleaseName, groupKey }) => {
    const unifiedReleaseId =
      canonicalReleaseIdByGroup.get(groupKey) ?? row.releaseId;

    if (!parsed.isGrouped) {
      if (
        unifiedReleaseId === row.releaseId &&
        canonicalReleaseName === row.releaseName
      ) {
        return row;
      }
      return {
        ...row,
        releaseId: unifiedReleaseId,
        releaseName: canonicalReleaseName,
      };
    }

    return {
      ...row,
      releaseId: unifiedReleaseId,
      releaseName: canonicalReleaseName,
      effortRaw: parsed.effortRaw ?? row.effortRaw,
      effortNormalized: parsed.effortNormalized ?? row.effortNormalized,
      effortOrder: parsed.effortOrder ?? row.effortOrder,
      effortLadderType: parsed.effortLadderType ?? row.effortLadderType,
      isReasoningModel: parsed.isReasoningModel ?? row.isReasoningModel,
      isGrouped: true,
    };
  });
}

export async function getActiveSnapshot(): Promise<
  typeof dataSnapshots.$inferSelect | null
> {
  await assertSchemaCompatible();
  const db = getDb();
  const [snap] = await db
    .select()
    .from(dataSnapshots)
    .where(eq(dataSnapshots.status, "active"))
    .orderBy(desc(dataSnapshots.fetchedAt))
    .limit(1);
  return snap ?? null;
}

export async function getActiveMeasurements(
  snapshotId?: string
): Promise<{ snapshot: Awaited<ReturnType<typeof getActiveSnapshot>>; rows: MeasurementRow[] }> {
  await assertSchemaCompatible();
  const db = getDb();
  // Named reconciliation entry point: only active/archived snapshots are
  // readable; staging/failed snapshots are never served (secretary ruling 5).
  const snapshot: Awaited<ReturnType<typeof getActiveSnapshot>> = snapshotId
    ? (
        await db
          .select()
          .from(dataSnapshots)
          .where(eq(dataSnapshots.id, snapshotId))
          .limit(1)
      ).filter((s) => s.status === "active" || s.status === "archived")[0] ?? null
    : await getActiveSnapshot();

  if (!snapshot) {
    return { snapshot: null, rows: [] };
  }

  const joined = await db
    .select({
      m: benchmarkMeasurements,
      v: modelVariants,
      r: modelReleases,
      c: modelCreators,
    })
    .from(benchmarkMeasurements)
    .innerJoin(modelVariants, eq(benchmarkMeasurements.variantId, modelVariants.id))
    .innerJoin(modelReleases, eq(modelVariants.modelReleaseId, modelReleases.id))
    .innerJoin(modelCreators, eq(modelReleases.creatorId, modelCreators.id))
    .where(eq(benchmarkMeasurements.snapshotId, snapshot.id));

  const rows: MeasurementRow[] = joined.map(({ m, v, r, c }) => {
    let agentUsage: AgentUsageSummary = {
      sample_count: 0,
      independent_user_count: 0,
      avg_input_tokens: null,
      avg_output_tokens: null,
      avg_reasoning_tokens: null,
      avg_cache_hit_rate: null,
      avg_api_calls: null,
      success_rate: null,
      time_range_start: null,
      time_range_end: null,
      scenario_statistics: [],
    };
    if (m.agentUsageJson) {
      try {
        agentUsage = JSON.parse(m.agentUsageJson) as AgentUsageSummary;
      } catch {
        // Fallback to empty usage
      }
    }

    const pricing = {
      inputPerMillion: m.inputPricePerMillion,
      outputPerMillion: m.outputPricePerMillion,
      cacheReadPerMillion: m.cacheReadPricePerMillion,
      cacheWritePerMillion: m.cacheWritePricePerMillion,
      currency: "USD" as const,
    };

    const devCost = calculateDeveloperAgentCost({
      pricing,
      provider: c.slug,
      contextWindow: r.contextWindow,
      effortNormalized: v.effortNormalized,
      isReasoningModel: v.isReasoningModel,
      profile: "standard",
    });
    let agentCost: AgentCostSummary = {
      p25: null,
      p50: null,
      p75: null,
      p90: null,
      mean: null,
      effective_cost: null,
      rasc: null,
      estimated_cost: devCost ? devCost.totalUsd : null,
      extra_tool_cost_mean: null,
    };
    if (m.agentCostJson) {
      try {
        agentCost = JSON.parse(m.agentCostJson) as AgentCostSummary;
      } catch {
        // Fallback to computed EAC
      }
    }

    let sources: string[] = [];
    if (m.dataSourcesJson) {
      try {
        sources = JSON.parse(m.dataSourcesJson) as string[];
      } catch {
        sources = [];
      }
    } else if (m.pricingSource) {
      sources = m.pricingSource.split("+").filter(Boolean);
    }

    let dataQuality: DataQualitySummary;
    if (
      m.dataQualityLevel &&
      m.dataQualityLevel !== "D" &&
      // Historical A/B rows without Package C quality evidence are not
      // trusted as measured; they fall through to fail-closed classification.
      (m.dataQualityLevel !== "A" && m.dataQualityLevel !== "B" || m.qualityEvidenceJson)
    ) {
      dataQuality = {
        level: m.dataQualityLevel as DataQualityLevel,
        source_type: m.dataSourceType as DataSourceType,
        sources,
        updated_at: m.dataUpdatedAt ?? m.fetchedAt,
        effort_token_diff_known: agentUsage.sample_count > 0,
      };
    } else {
      dataQuality = classifyDataQuality({
        usage: agentUsage,
        cost: agentCost,
        pricing,
        hasActualBilledSessions: false,
        allSessionsBilled: false,
        sources,
        updatedAt: m.dataUpdatedAt ?? m.fetchedAt,
      });
    }

    return {
      id: m.id,
      variantId: v.id,
      releaseId: r.id,
      creatorId: c.id,
      creatorName: m.frozenCreatorName ?? c.name,
      creatorSlug: m.frozenCreatorSlug ?? c.slug,
      creatorColor: c.color,
      family: r.family,
      releaseName: m.frozenReleaseName ?? r.name,
      releaseDate: m.frozenReleaseDate ?? r.releaseDate,
      contextWindow: m.frozenContextWindow ?? r.contextWindow,
      isOpenWeights: r.isOpenWeights,
      sourceUrl: m.sourceUrl,
      sourceSlug: v.sourceSlug,
      rawName: v.rawName,
      displayName: m.frozenDisplayName ?? v.displayName,
      effortRaw: v.effortRaw,
      effortNormalized: m.frozenEffortNormalized ?? v.effortNormalized,
      effortOrder: v.effortOrder,
      effortLadderType: v.effortLadderType as EffortLadderType,
      isReasoningModel: v.isReasoningModel,
      isGrouped: v.isGrouped,
      source: m.source,
      indexName: m.indexName,
      indexVersion: m.indexVersion,
      intelligenceScore: m.intelligenceScore,
      codingScore: m.codingScore,
      agenticScore: m.agenticScore,
      inputPricePerMillion: m.inputPricePerMillion,
      outputPricePerMillion: m.outputPricePerMillion,
      cacheReadPricePerMillion: m.cacheReadPricePerMillion,
      cacheWritePricePerMillion: m.cacheWritePricePerMillion,
      outputTokensPerSecond: m.outputTokensPerSecond,
      timeToFirstToken: m.timeToFirstToken,
      timePerTask: m.timePerTask,
      measuredAt: m.measuredAt,
      fetchedAt: m.fetchedAt,
      pricingSource: m.pricingSource,
      snapshotId: m.snapshotId,
      agentUsage,
      agentCost,
      dataQuality,
    };
  });

  // Frozen columns are authoritative: no read-path re-canonicalization.
  return { snapshot, rows };
}

export async function getSyncStatusInfo() {
  await assertSchemaCompatible();
  const db = getDb();
  const activeSnapshot = await getActiveSnapshot();
  const recentJobs = await db
    .select()
    .from(syncJobs)
    .orderBy(desc(syncJobs.startedAt))
    .limit(15);

  const snapshots = await db
    .select()
    .from(dataSnapshots)
    .orderBy(desc(dataSnapshots.fetchedAt))
    .limit(20);

  return {
    activeSnapshot,
    recentJobs,
    snapshots,
    demoModeEnv: process.env.DEMO_MODE === "true",
    hasApiKey: Boolean(process.env.AA_API_KEY?.trim()),
    // Single scheduler-config source (lib/ops/sync-config.ts): the same
    // value drives the production worker's actual schedule.
    syncIntervalMinutes: getSyncIntervalMinutes(),
    apiTier: process.env.AA_API_TIER ?? "free",
  };
}

/**
 * Named internal reconciliation read (Package B ruling 3): exposes the
 * DB-only `legacy_backfill` marker and Package C field provenance for
 * operator verification. This is intentionally NOT used by any public
 * API/JSON route, so the marker never leaks to public payloads.
 */
export async function getSnapshotReconciliation(snapshotId: string) {
  await assertSchemaCompatible();
  const db = getDb();
  const rows = await db
    .select({
      measurementId: benchmarkMeasurements.id,
      variantId: benchmarkMeasurements.variantId,
      legacyBackfill: benchmarkMeasurements.legacyBackfill,
      fieldSourcesJson: benchmarkMeasurements.fieldSourcesJson,
      firstObservedAt: benchmarkMeasurements.firstObservedAt,
    })
    .from(benchmarkMeasurements)
    .where(eq(benchmarkMeasurements.snapshotId, snapshotId));
  return rows.map((r) => ({
    measurementId: r.measurementId,
    variantId: r.variantId,
    legacyBackfill: r.legacyBackfill === 1,
    fieldSources: r.fieldSourcesJson
      ? (JSON.parse(r.fieldSourcesJson) as Record<string, unknown>)
      : null,
    firstObservedAt: r.firstObservedAt,
  }));
}
