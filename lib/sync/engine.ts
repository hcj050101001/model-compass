import crypto from "node:crypto";
import { eq, and, gt, desc } from "drizzle-orm";
import { assertSchemaCompatible, getDb } from "@/lib/database";
import {
  benchmarkMeasurements,
  dataSnapshots,
  modelCreators,
  modelReleases,
  modelVariants,
  syncJobs,
  syncLocks,
} from "@/lib/database/schema";
import { getActiveMeasurements, getSnapshotReconciliation } from "@/lib/database/queries";
import { runArtificialAnalysisAdapter } from "@/lib/data-sources/artificial-analysis/adapter";
import {
  mapAAModelsToNormalized,
  type NormalizedBundle,
} from "@/lib/data-sources/artificial-analysis/mapper";
import { enrichWithOpenRouter } from "@/lib/data-sources/openrouter/adapter";
import { enrichWithLiteLLMPricing } from "@/lib/data-sources/pricing/litellm-adapter";
import { ingestAllAgentSessions } from "@/lib/data-sources/agent-sessions";
import { DEMO_INDEX_VERSION, getDemoAAModels } from "@/lib/data-sources/demo/dataset";
import { calculateDeveloperAgentCost } from "@/lib/agent-cost/developer-cost";
import { computeRealAgentStatsAndRasc } from "@/lib/agent-cost/rasc";
import { classifyDataQuality } from "@/lib/agent-cost/quality";
import type {
  AgentCostSummary,
  AgentUsageSummary,
  DataQualitySummary,
  PricingProvenance,
  RawAgentSessionRecord,
} from "@/lib/agent-cost/types";
import { exportStandardizedSnapshotFiles } from "./standardized-export";

const LOCK_KEY = "global_data_sync";
const LOCK_TTL_MS = 5 * 60 * 1000;

export interface SyncRunResult {
  jobId: string;
  status: "success" | "no_change" | "failed" | "skipped_locked" | "skipped_cooldown";
  snapshotId?: string;
  fetchedCount: number;
  validCount: number;
  rejectedCount: number;
  rateLimitRemaining: number | null;
  rateLimitReset: string | null;
  errorMessage?: string;
  isDemo: boolean;
}

export interface EnrichedMeasurementExtra {
  agentUsageJson: string;
  agentCostJson: string;
  dataQualityLevel: string;
  dataSourceType: string;
  dataSourcesJson: string;
  dataUpdatedAt: string;
  /** Package C: serialized per-field pricing provenance for this row. */
  fieldSourcesJson?: string;
  /** Package C: serialized quality-evidence envelope (grading + breakdown). */
  qualityEvidenceJson?: string;
  /** Package C: digest of the exact measured sample set (hash input). */
  sampleSetDigest?: string;
}

export function computeBundleContentHash(
  bundle: NormalizedBundle,
  indexVersion: string,
  extras?: Map<string, EnrichedMeasurementExtra>
): string {
  const releaseByVariantId = new Map<string, string>();
  for (const v of bundle.variants) releaseByVariantId.set(v.id, v.modelReleaseId);
  const canonical = {
    indexVersion,
    // Package C: template/evidence version placeholder until Package D lands
    // its template version constant (design sec.2.4 reserves this field).
    evidenceVersion: "c-evidence-v1",
    creators: bundle.creators.map((c) => c.slug).sort(),
    variants: bundle.variants
      .map((v) => ({
        id: v.sourceId,
        rawName: v.rawName,
        effort: v.effortNormalized,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    measurements: bundle.measurements
      .map((m) => ({
        variantId: m.variantId,
        // Frozen release identity participates in the hash.
        releaseId: releaseByVariantId.get(m.variantId) ?? null,
        intelligenceScore: m.intelligenceScore,
        codingScore: m.codingScore,
        agenticScore: m.agenticScore,
        inputPricePerMillion: m.inputPricePerMillion,
        outputPricePerMillion: m.outputPricePerMillion,
        cacheReadPricePerMillion: m.cacheReadPricePerMillion,
        cacheWritePricePerMillion: m.cacheWritePricePerMillion,
        outputTokensPerSecond: m.outputTokensPerSecond,
        timeToFirstToken: m.timeToFirstToken,
        qualityLevel: extras?.get(m.variantId)?.dataQualityLevel ?? "D",
        agentCost: extras?.get(m.variantId)?.agentCostJson ?? null,
        // Source changes change the hash even when values are identical.
        fieldSources: extras?.get(m.variantId)?.fieldSourcesJson ?? null,
        // Sample-set changes change the hash even when aggregates are equal.
        sampleSetDigest: extras?.get(m.variantId)?.sampleSetDigest ?? null,
      }))
      .sort((a, b) => a.variantId.localeCompare(b.variantId)),
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

async function acquireLock(owner: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + LOCK_TTL_MS).toISOString();

  const existing = await db
    .select()
    .from(syncLocks)
    .where(and(eq(syncLocks.lockKey, LOCK_KEY), gt(syncLocks.expiresAt, nowIso)));

  if (existing.length > 0) {
    return false;
  }

  await db
    .insert(syncLocks)
    .values({
      lockKey: LOCK_KEY,
      lockedAt: nowIso,
      expiresAt: expiresIso,
      owner,
    })
    .onConflictDoUpdate({
      target: syncLocks.lockKey,
      set: {
        lockedAt: nowIso,
        expiresAt: expiresIso,
        owner,
      },
    });
  return true;
}

async function releaseLock(owner: string): Promise<void> {
  const db = getDb();
  await db
    .delete(syncLocks)
    .where(and(eq(syncLocks.lockKey, LOCK_KEY), eq(syncLocks.owner, owner)));
}

function normalizeModelLookup(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function computeBundleAgentCosts(params: {
  bundle: NormalizedBundle;
  sessions: RawAgentSessionRecord[];
  sessionSources: string[];
  fetchedAt: string;
}): Map<string, EnrichedMeasurementExtra> {
  const { bundle, sessions, fetchedAt } = params;
  const variantById = new Map(bundle.variants.map((v) => [v.id, v]));
  const releaseById = new Map(bundle.releases.map((r) => [r.id, r]));

  // Group sessions by normalized modelId or modelName + effort
  const sessionsByKey = new Map<string, RawAgentSessionRecord[]>();
  for (const s of sessions) {
    const key = normalizeModelLookup(s.modelName ?? s.modelId);
    const list = sessionsByKey.get(key) ?? [];
    list.push(s);
    sessionsByKey.set(key, list);
  }

  const extras = new Map<string, EnrichedMeasurementExtra>();

  for (const m of bundle.measurements) {
    const variant = variantById.get(m.variantId);
    const release = variant ? releaseById.get(variant.modelReleaseId) : undefined;
    const pricing = {
      inputPerMillion: m.inputPricePerMillion,
      outputPerMillion: m.outputPricePerMillion,
      cacheReadPerMillion: m.cacheReadPricePerMillion,
      cacheWritePerMillion: m.cacheWritePricePerMillion,
      currency: "USD" as const,
    };

    const devCost = calculateDeveloperAgentCost({
      pricing,
      provider: release?.creatorId ?? "default",
      contextWindow: release?.contextWindow ?? null,
      effortNormalized: variant?.effortNormalized ?? null,
      isReasoningModel: variant?.isReasoningModel ?? null,
      profile: "standard",
    });
    const matchedSessions = variant
      ? (sessionsByKey.get(normalizeModelLookup(variant.sourceSlug)) ??
          sessionsByKey.get(normalizeModelLookup(variant.displayName)) ??
          (release
            ? sessionsByKey.get(normalizeModelLookup(release.name))
            : undefined) ??
          [])
      : [];

    // Filter by effort if session specifies reasoningEffort and variant has effortNormalized.
    // Package C: a session whose provider does not match the release creator
    // never matches, even when model names collide across vendors.
    const creatorSlug = release
      ? bundle.creators.find((c) => c.id === release.creatorId)?.slug
      : undefined;
    const effortFiltered = matchedSessions.filter((s) => {
      if (
        creatorSlug &&
        s.provider &&
        normalizeModelLookup(s.provider) !== normalizeModelLookup(creatorSlug)
      ) {
        return false;
      }
      if (!s.reasoningEffort || !variant?.effortNormalized) return true;
      return (
        s.reasoningEffort.toLowerCase() === variant.effortNormalized.toLowerCase()
      );
    });

    const rascResult = computeRealAgentStatsAndRasc({
      sessions: effortFiltered,
      pricing,
    });

    const agentUsage: AgentUsageSummary = rascResult.usage;
    const agentCost: AgentCostSummary = {
      ...rascResult.cost,
      estimated_cost: devCost ? devCost.totalUsd : null,
    };

    const sources = Array.from(
      new Set([
        ...(m.pricingSource ? m.pricingSource.split("+").filter(Boolean) : []),
        ...rascResult.sources,
      ])
    );

    const dataQuality: DataQualitySummary = classifyDataQuality({
      usage: agentUsage,
      cost: agentCost,
      pricing,
      hasActualBilledSessions: rascResult.hasActualBilledSessions,
      allSessionsBilled: rascResult.allSessionsBilled,
      sources,
      updatedAt: fetchedAt,
      effortTokenDiffKnown: effortFiltered.some((s) => Boolean(s.reasoningEffort)),
      now: fetchedAt,
      billedSampleCount: rascResult.billedSampleCount,
      tokenPricedSampleCount: rascResult.tokenPricedSampleCount,
      billedAmountUsd: rascResult.billedAmountUsd,
      tokenPricedAmountUsd: rascResult.tokenPricedAmountUsd,
      verifiedEffort: variant?.effortNormalized ?? null,
    });

    // Per-field provenance: fields with a value but no recorded origin are
    // marked source "unknown" (distinct from a missing/null value).
    const provenance: PricingProvenance = { ...(m.fieldSources ?? {}) };
    const pricedFields: Array<
      ["input" | "output" | "cacheRead" | "cacheWrite", number | null]
    > = [
      ["input", m.inputPricePerMillion],
      ["output", m.outputPricePerMillion],
      ["cacheRead", m.cacheReadPricePerMillion],
      ["cacheWrite", m.cacheWritePricePerMillion],
    ];
    for (const [field, value] of pricedFields) {
      if (value !== null && !provenance[field]) {
        provenance[field] = {
          source: "unknown",
          upstreamKey: null,
          currency: null,
          unit: null,
          observedAt: null,
          firstObservedAt: null,
        };
      }
    }

    extras.set(m.variantId, {
      agentUsageJson: JSON.stringify(agentUsage),
      agentCostJson: JSON.stringify(agentCost),
      dataQualityLevel: dataQuality.level,
      dataSourceType: dataQuality.source_type,
      dataSourcesJson: JSON.stringify(dataQuality.sources),
      dataUpdatedAt: fetchedAt,
      fieldSourcesJson: JSON.stringify(provenance),
      qualityEvidenceJson: JSON.stringify({
        version: "c-evidence-v1",
        quality: dataQuality,
        sampleSetDigest: rascResult.sampleSetDigest,
      }),
      sampleSetDigest: rascResult.sampleSetDigest,
    });
  }

  return extras;
}

export async function commitSnapshotAtomically(params: {
  bundle: NormalizedBundle;
  extras: Map<string, EnrichedMeasurementExtra>;
  source: string;
  indexVersion: string;
  fetchedAt: string;
  isDemo: boolean;
}): Promise<{ snapshotId: string; status: "success" | "no_change" }> {
  const { bundle, extras, source, indexVersion, fetchedAt, isDemo } = params;
  const db = getDb();
  const contentHash = computeBundleContentHash(bundle, indexVersion, extras);

  const [activeSnapshot] = await db
    .select()
    .from(dataSnapshots)
    .where(eq(dataSnapshots.status, "active"))
    .orderBy(desc(dataSnapshots.fetchedAt))
    .limit(1);

  if (
    activeSnapshot &&
    activeSnapshot.contentHash === contentHash &&
    activeSnapshot.source === source &&
    activeSnapshot.isDemo === isDemo
  ) {
    return { snapshotId: activeSnapshot.id, status: "no_change" };
  }

  const snapshotId = `snap_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  // Package C firstObservedAt continuation (design sec.2.4 / C-5): when the
  // same (variant, field, value, source, upstreamKey) was already present in
  // the current active snapshot, its first-observation time is carried over;
  // only genuinely new quotes start a new first-observation at this fetch.
  const creatorById = new Map(bundle.creators.map((c) => [c.id, c]));
  const releaseById = new Map(bundle.releases.map((r) => [r.id, r]));
  const variantById = new Map(bundle.variants.map((v) => [v.id, v]));
  const prevByVariant = new Map<
    string,
    { fieldSourcesJson: string | null; prices: Record<string, number | null> }
  >();
  if (activeSnapshot) {
    const prevRows = await db
      .select()
      .from(benchmarkMeasurements)
      .where(eq(benchmarkMeasurements.snapshotId, activeSnapshot.id));
    for (const pr of prevRows) {
      prevByVariant.set(pr.variantId, {
        fieldSourcesJson: pr.fieldSourcesJson,
        prices: {
          input: pr.inputPricePerMillion,
          output: pr.outputPricePerMillion,
          cacheRead: pr.cacheReadPricePerMillion,
          cacheWrite: pr.cacheWritePricePerMillion,
          contextWindow: pr.frozenContextWindow,
        },
      });
    }
  }
  const priceOf = (
    m: NormalizedBundle["measurements"][number],
    field: string
  ): number | null => {
    switch (field) {
      case "input":
        return m.inputPricePerMillion;
      case "output":
        return m.outputPricePerMillion;
      case "cacheRead":
        return m.cacheReadPricePerMillion;
      case "cacheWrite":
        return m.cacheWritePricePerMillion;
      case "contextWindow":
        return variantById.get(m.variantId)
          ? (releaseById.get(variantById.get(m.variantId)!.modelReleaseId)
              ?.contextWindow ?? null)
          : null;
      default:
        return null;
    }
  };
  const adjustedProvenance = new Map<
    string,
    { json: string; firstObservedAt: string | null }
  >();
  for (const m of bundle.measurements) {
    const extra = extras.get(m.variantId);
    let prov: PricingProvenance = {};
    if (extra?.fieldSourcesJson) {
      try {
        prov = JSON.parse(extra.fieldSourcesJson) as PricingProvenance;
      } catch {
        prov = { ...(m.fieldSources ?? {}) };
      }
    } else if (m.fieldSources) {
      prov = { ...m.fieldSources };
    }
    const prev = prevByVariant.get(m.variantId);
    let prevProv: PricingProvenance = {};
    if (prev?.fieldSourcesJson) {
      try {
        prevProv = JSON.parse(prev.fieldSourcesJson) as PricingProvenance;
      } catch {
        prevProv = {};
      }
    }
    let earliest: string | null = null;
    for (const [field, entry] of Object.entries(prov)) {
      if (!entry) continue;
      const prevEntry = prevProv[field as keyof PricingProvenance];
      const sameQuote =
        prevEntry &&
        prevEntry.source === entry.source &&
        prevEntry.upstreamKey === entry.upstreamKey &&
        prev !== undefined &&
        prev.prices[field] !== undefined &&
        prev.prices[field] === priceOf(m, field);
      entry.firstObservedAt = sameQuote
        ? (prevEntry.firstObservedAt ?? fetchedAt)
        : (entry.firstObservedAt ?? fetchedAt);
      if (!earliest || entry.firstObservedAt < earliest) {
        earliest = entry.firstObservedAt;
      }
    }
    adjustedProvenance.set(m.variantId, {
      json: JSON.stringify(prov),
      firstObservedAt: earliest,
    });
  }

  await db.transaction(async (tx) => {
    for (const c of bundle.creators) {
      await tx
        .insert(modelCreators)
        .values(c)
        .onConflictDoUpdate({
          target: modelCreators.id,
          set: {
            name: c.name,
            country: c.country,
            website: c.website,
            color: c.color,
          },
        });
    }

    for (const r of bundle.releases) {
      await tx
        .insert(modelReleases)
        .values(r)
        .onConflictDoUpdate({
          target: modelReleases.id,
          set: {
            family: r.family,
            name: r.name,
            version: r.version,
            releaseDate: r.releaseDate,
            contextWindow: r.contextWindow,
            isOpenWeights: r.isOpenWeights,
            sourceUrl: r.sourceUrl,
          },
        });
    }

    for (const v of bundle.variants) {
      await tx
        .insert(modelVariants)
        .values(v)
        .onConflictDoUpdate({
          target: modelVariants.id,
          set: {
            modelReleaseId: v.modelReleaseId,
            rawName: v.rawName,
            displayName: v.displayName,
            effortRaw: v.effortRaw,
            effortNormalized: v.effortNormalized,
            effortOrder: v.effortOrder,
            effortLadderType: v.effortLadderType,
            isReasoningModel: v.isReasoningModel,
            isGrouped: v.isGrouped,
          },
        });
    }

    await tx.insert(dataSnapshots).values({
      id: snapshotId,
      source,
      benchmarkVersion: indexVersion,
      fetchedAt,
      modelCount: bundle.releases.length,
      variantCount: bundle.variants.length,
      contentHash,
      status: "staging",
      isDemo,
    });

    for (const m of bundle.measurements) {
      const extra = extras.get(m.variantId);
      const variant = variantById.get(m.variantId);
      const release = variant
        ? releaseById.get(variant.modelReleaseId)
        : undefined;
      const creator = release ? creatorById.get(release.creatorId) : undefined;
      const adj = adjustedProvenance.get(m.variantId);
      const { fieldSources: _fieldSources, ...measurementCore } = m;
      void _fieldSources;
      await tx.insert(benchmarkMeasurements).values({
        ...measurementCore,
        id: `${m.id}_${snapshotId}`,
        snapshotId,
        agentUsageJson: extra?.agentUsageJson ?? null,
        agentCostJson: extra?.agentCostJson ?? null,
        dataQualityLevel: extra?.dataQualityLevel ?? "D",
        dataSourceType: extra?.dataSourceType ?? "unavailable",
        dataSourcesJson: extra?.dataSourcesJson ?? "[]",
        dataUpdatedAt: extra?.dataUpdatedAt ?? fetchedAt,
        // Package B: frozen metadata written from this same normalization
        // result, so later dimension renames never rewrite history.
        frozenCreatorName: creator?.name ?? null,
        frozenCreatorSlug: creator?.slug ?? null,
        frozenReleaseName: release?.name ?? null,
        frozenReleaseDate: release?.releaseDate ?? null,
        frozenContextWindow: release?.contextWindow ?? null,
        frozenDisplayName: variant?.displayName ?? null,
        frozenEffortNormalized: variant?.effortNormalized ?? null,
        legacyBackfill: 0,
        // Package C: per-field provenance + quality evidence.
        fieldSourcesJson: adj?.json ?? extra?.fieldSourcesJson ?? null,
        qualityEvidenceJson: extra?.qualityEvidenceJson ?? null,
        firstObservedAt: adj?.firstObservedAt ?? null,
      });
    }

    await tx
      .update(dataSnapshots)
      .set({ status: "archived" })
      .where(eq(dataSnapshots.status, "active"));

    await tx
      .update(dataSnapshots)
      .set({ status: "active" })
      .where(eq(dataSnapshots.id, snapshotId));
  });

  return { snapshotId, status: "success" };
}

async function buildBundleFromExistingLiveSnapshot(
  fetchedAt: string
): Promise<{ bundle: NormalizedBundle; indexVersion: string; source: string } | null> {
  const { snapshot, rows } = await getActiveMeasurements();
  if (!snapshot || snapshot.isDemo || rows.length === 0) return null;
  // Carry frozen provenance/first-observation through the no-key reuse path;
  // reuse must not re-date or re-attribute existing quotes.
  const reconciliation = await getSnapshotReconciliation(snapshot.id);
  const provenanceByVariant = new Map(
    reconciliation.map((r) => [r.variantId, r.fieldSources])
  );

  const creatorMap = new Map<string, NormalizedBundle["creators"][number]>();
  const releaseMap = new Map<string, NormalizedBundle["releases"][number]>();
  const variants: NormalizedBundle["variants"] = [];
  const measurements: NormalizedBundle["measurements"] = [];
  const seenVariantIds = new Set<string>();

  for (const r of rows) {
    if (!creatorMap.has(r.creatorId)) {
      creatorMap.set(r.creatorId, {
        id: r.creatorId,
        name: r.creatorName,
        slug: r.creatorSlug,
        country: null,
        website: null,
        color: r.creatorColor,
      });
    }
    if (!releaseMap.has(r.releaseId)) {
      releaseMap.set(r.releaseId, {
        id: r.releaseId,
        creatorId: r.creatorId,
        family: r.family,
        name: r.releaseName,
        version: r.releaseDate,
        releaseDate: r.releaseDate,
        contextWindow: r.contextWindow,
        isOpenWeights: r.isOpenWeights,
        sourceUrl: r.sourceUrl,
      });
    }
    if (!seenVariantIds.has(r.variantId)) {
      seenVariantIds.add(r.variantId);
      variants.push({
        id: r.variantId,
        modelReleaseId: r.releaseId,
        sourceId: r.variantId.replace(/^var_/, ""),
        sourceSlug: r.sourceSlug,
        rawName: r.rawName,
        displayName: r.displayName,
        effortRaw: r.effortRaw,
        effortNormalized: r.effortNormalized,
        effortOrder: r.effortOrder,
        effortLadderType: r.effortLadderType,
        isReasoningModel: r.isReasoningModel,
        isGrouped: r.isGrouped,
      });
    }
    measurements.push({
      id: `meas_${r.variantId}_${snapshot.benchmarkVersion}`,
      variantId: r.variantId,
      source: r.source,
      sourceUrl: r.sourceUrl,
      indexName: r.indexName,
      indexVersion: r.indexVersion,
      intelligenceScore: r.intelligenceScore,
      codingScore: r.codingScore,
      agenticScore: r.agenticScore,
      inputPricePerMillion: r.inputPricePerMillion,
      outputPricePerMillion: r.outputPricePerMillion,
      cacheReadPricePerMillion: r.cacheReadPricePerMillion,
      cacheWritePricePerMillion: r.cacheWritePricePerMillion,
      outputTokensPerSecond: r.outputTokensPerSecond,
      timeToFirstToken: r.timeToFirstToken,
      timePerTask: r.timePerTask,
      measuredAt: r.measuredAt,
      fetchedAt,
      pricingSource: r.pricingSource,
      fieldSources:
        (provenanceByVariant.get(r.variantId) as PricingProvenance | undefined) ??
        undefined,
    });
  }

  return {
    bundle: {
      creators: Array.from(creatorMap.values()),
      releases: Array.from(releaseMap.values()),
      variants,
      measurements,
      rejectedCount: 0,
    },
    indexVersion: snapshot.benchmarkVersion,
    source: snapshot.source,
  };
}

export async function runSyncJob(options?: {
  manual?: boolean;
  forceDemo?: boolean;
  aaFetchImpl?: typeof fetch;
  openRouterFetchImpl?: typeof fetch;
  liteLLMFetchImpl?: typeof fetch;
}): Promise<SyncRunResult> {
  await assertSchemaCompatible();
  const db = getDb();
  const owner = `sync_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

  if (options?.manual) {
    const cooldownSec = Number.parseInt(
      process.env.MANUAL_SYNC_COOLDOWN_SECONDS ?? "120",
      10
    );
    const [lastJob] = await db
      .select()
      .from(syncJobs)
      .orderBy(desc(syncJobs.startedAt))
      .limit(1);

    if (lastJob) {
      const elapsedSec =
        (Date.now() - new Date(lastJob.startedAt).getTime()) / 1000;
      if (elapsedSec < cooldownSec) {
        return {
          jobId: lastJob.id,
          status: "skipped_cooldown",
          fetchedCount: 0,
          validCount: 0,
          rejectedCount: 0,
          rateLimitRemaining: lastJob.rateLimitRemaining,
          rateLimitReset: lastJob.rateLimitReset,
          errorMessage: `Manual sync cooldown active. Wait ${Math.ceil(cooldownSec - elapsedSec)}s.`,
          isDemo: process.env.DEMO_MODE === "true",
        };
      }
    }
  }

  const locked = await acquireLock(owner);
  if (!locked) {
    return {
      jobId: "locked",
      status: "skipped_locked",
      fetchedCount: 0,
      validCount: 0,
      rejectedCount: 0,
      rateLimitRemaining: null,
      rateLimitReset: null,
      errorMessage: "Another sync job is currently running.",
      isDemo: process.env.DEMO_MODE === "true",
    };
  }

  const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const startedAt = new Date().toISOString();
  const apiKey = process.env.AA_API_KEY?.trim() ?? "";

  let isDemo =
    options?.forceDemo === true || process.env.DEMO_MODE === "true";

  await db.insert(syncJobs).values({
    id: jobId,
    startedAt,
    status: "running",
    fetchedCount: 0,
    validCount: 0,
    rejectedCount: 0,
  });

  try {
    let bundle: NormalizedBundle;
    let source: string;
    let indexVersion: string;
    let fetchedCount: number;
    let rateLimitRemaining: number | null = null;
    let rateLimitReset: string | null = null;

    if (!isDemo && apiKey.length > 0) {
      const tier =
        (process.env.AA_API_TIER as "free" | "pro" | "commercial") ?? "free";
      const aaResult = await runArtificialAnalysisAdapter({
        apiKey,
        tier,
        baseUrl: process.env.AA_API_BASE_URL,
        fetchImpl: options?.aaFetchImpl,
      });
      source = "artificial-analysis";
      indexVersion = aaResult.indexVersion;
      fetchedCount = aaResult.fetchedCount;
      bundle = aaResult.bundle;
      rateLimitRemaining = aaResult.rateLimitRemaining;
      rateLimitReset = aaResult.rateLimitReset;
    } else if (!isDemo) {
      // No AA_API_KEY configured: reuse existing live AA intelligence snapshot if available
      const existingLive = await buildBundleFromExistingLiveSnapshot(startedAt);
      if (existingLive) {
        bundle = existingLive.bundle;
        indexVersion = existingLive.indexVersion;
        source = existingLive.source;
        fetchedCount = bundle.measurements.length;
      } else {
        isDemo = true;
        const demoItems = getDemoAAModels();
        source = "demo-synthetic";
        indexVersion = DEMO_INDEX_VERSION;
        fetchedCount = demoItems.length;
        bundle = mapAAModelsToNormalized({
          items: demoItems,
          indexVersion,
          fetchedAt: startedAt,
          source,
        });
      }
    } else {
      const demoItems = getDemoAAModels();
      source = "demo-synthetic";
      indexVersion = DEMO_INDEX_VERSION;
      fetchedCount = demoItems.length;
      bundle = mapAAModelsToNormalized({
        items: demoItems,
        indexVersion,
        fetchedAt: startedAt,
        source,
      });
    }

    if (!isDemo) {
      if (process.env.LITELLM_PRICING_ENABLED !== "false") {
        try {
          await enrichWithLiteLLMPricing(bundle, {
            fetchImpl: options?.liteLLMFetchImpl,
          });
        } catch (llErr) {
          console.warn(
            "[sync] LiteLLM pricing enrichment skipped due to error:",
            llErr instanceof Error ? llErr.message : String(llErr)
          );
        }
      }

      if (process.env.OPENROUTER_ENABLED !== "false") {
        try {
          await enrichWithOpenRouter(bundle, {
            baseUrl: process.env.OPENROUTER_API_BASE_URL,
            fetchImpl: options?.openRouterFetchImpl,
          });
        } catch (orErr) {
          console.warn(
            "[sync] OpenRouter enrichment skipped due to error:",
            orErr instanceof Error ? orErr.message : String(orErr)
          );
        }
      }
    }

    if (bundle.measurements.length === 0) {
      throw new Error(
        "Normalized measurement set is empty; aborting snapshot commit."
      );
    }

    const sessionReport = await ingestAllAgentSessions({ windowDays: 30 });
    const extras = computeBundleAgentCosts({
      bundle,
      sessions: sessionReport.sessions,
      sessionSources: sessionReport.sources,
      fetchedAt: startedAt,
    });

    const commitRes = await commitSnapshotAtomically({
      bundle,
      extras,
      source,
      indexVersion,
      fetchedAt: startedAt,
      isDemo,
    });

    const activeData = await getActiveMeasurements(commitRes.snapshotId);
    exportStandardizedSnapshotFiles({
      rows: activeData.rows,
      indexVersion,
      generatedAt: startedAt,
      isDemo,
    });

    const completedAt = new Date().toISOString();
    await db
      .update(syncJobs)
      .set({
        completedAt,
        status: commitRes.status,
        fetchedCount,
        validCount: bundle.measurements.length,
        rejectedCount: bundle.rejectedCount + sessionReport.rejectedCount,
        rateLimitRemaining,
        rateLimitReset,
      })
      .where(eq(syncJobs.id, jobId));

    return {
      jobId,
      status: commitRes.status,
      snapshotId: commitRes.snapshotId,
      fetchedCount,
      validCount: bundle.measurements.length,
      rejectedCount: bundle.rejectedCount + sessionReport.rejectedCount,
      rateLimitRemaining,
      rateLimitReset,
      isDemo,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await db
      .update(syncJobs)
      .set({
        completedAt: new Date().toISOString(),
        status: "failed",
        errorMessage,
      })
      .where(eq(syncJobs.id, jobId));

    return {
      jobId,
      status: "failed",
      fetchedCount: 0,
      validCount: 0,
      rejectedCount: 0,
      rateLimitRemaining: null,
      rateLimitReset: null,
      errorMessage,
      isDemo,
    };
  } finally {
    await releaseLock(owner);
  }
}
