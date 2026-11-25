import { desc, eq } from "drizzle-orm";
import { ensureSchema, getDb } from "./index";
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
  await ensureSchema();
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
  await ensureSchema();
  const db = getDb();
  const snapshot: Awaited<ReturnType<typeof getActiveSnapshot>> = snapshotId
    ? (
        await db
          .select()
          .from(dataSnapshots)
          .where(eq(dataSnapshots.id, snapshotId))
          .limit(1)
      )[0] ?? null
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
    if (m.dataQualityLevel && m.dataQualityLevel !== "D") {
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
      creatorName: c.name,
      creatorSlug: c.slug,
      creatorColor: c.color,
      family: r.family,
      releaseName: r.name,
      releaseDate: r.releaseDate,
      contextWindow: r.contextWindow,
      isOpenWeights: r.isOpenWeights,
      sourceUrl: m.sourceUrl,
      sourceSlug: v.sourceSlug,
      rawName: v.rawName,
      displayName: v.displayName,
      effortRaw: v.effortRaw,
      effortNormalized: v.effortNormalized,
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

  return { snapshot, rows: canonicalizeMeasurementRows(rows) };
}

export async function getSyncStatusInfo() {
  await ensureSchema();
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
    syncIntervalMinutes: Number.parseInt(
      process.env.DATA_SYNC_INTERVAL_MINUTES ?? "60",
      10
    ),
    apiTier: process.env.AA_API_TIER ?? "free",
  };
}
