import crypto from "node:crypto";
import { eq, and, ne, desc, sql } from "drizzle-orm";
import { assertSchemaCompatible, getDb } from "@/lib/database";
import {
  benchmarkMeasurements,
  dataSnapshots,
  modelCreators,
  modelReleases,
  modelVariants,
  syncJobs,
} from "@/lib/database/schema";
import { getActiveMeasurements } from "@/lib/database/queries";
import { runArtificialAnalysisAdapter } from "@/lib/data-sources/artificial-analysis/adapter";
import {
  mapAAModelsToNormalized,
  type NormalizedBundle,
} from "@/lib/data-sources/artificial-analysis/mapper";
import { enrichWithOpenRouter } from "@/lib/data-sources/openrouter/adapter";
import { enrichWithLiteLLMPricing } from "@/lib/data-sources/pricing/litellm-adapter";
import { ingestAllAgentSessions } from "@/lib/data-sources/agent-sessions";
import { DEMO_INDEX_VERSION, getDemoAAModels } from "@/lib/data-sources/demo/dataset";
import {
  calculateDeveloperAgentCost,
  MULTI_TURN_TEMPLATE_VERSION,
} from "@/lib/agent-cost/developer-cost";
import { computeRealAgentStatsAndRasc } from "@/lib/agent-cost/rasc";
import { classifyDataQuality } from "@/lib/agent-cost/quality";
import type {
  AgentCostSummary,
  AgentUsageSummary,
  DataQualitySummary,
  PricingProvenance,
  RawAgentSessionRecord,
} from "@/lib/agent-cost/types";
import {
  buildStandardizedExportPayload,
  readPublicationFile,
  sha256Hex,
  writeDistributionCopies,
  writeImmutablePublicationFile,
} from "./standardized-export";
import {
  acquireSyncLease,
  getSyncLockTtlSeconds,
  releaseSyncLease,
  renewSyncLease,
  SYNC_LOCK_KEY,
} from "./lease";
import { countCoverage, evaluateCoverage } from "./coverage";
import { getManualSyncCooldownSeconds } from "@/lib/ops/sync-config";
import { AAApiError } from "@/lib/data-sources/artificial-analysis/client";

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
  /** Structured reason code for failed/skipped outcomes (Package E). */
  reasonCode?: string;
  /**
   * True when the publication itself committed (job terminal state is
   * success/no_change) but writing the distribution copies failed; the
   * copies are repaired idempotently by a later no_change run.
   */
  distributionPending?: boolean;
  isDemo: boolean;
}

/** Failure carrying a stable, redacted reason code for jobs/CLI/status. */
export class SyncFailure extends Error {
  constructor(
    public readonly reasonCode: string,
    message: string
  ) {
    super(message);
    this.name = "SyncFailure";
  }
}

class LeaseLostError extends SyncFailure {
  constructor() {
    super(
      "lease_lost",
      "Sync lease was lost (expired or taken over); aborting before any activation write."
    );
    this.name = "LeaseLostError";
  }
}

/**
 * Fault-injection points for publication reconciliation tests
 * (MODEL_COMPASS_FAULT_INJECT=<point>). Never set in production.
 */
export type SyncFaultPoint =
  | "after_staging"
  | "export_write"
  | "before_activation"
  | "after_activation";

function maybeInjectFault(point: SyncFaultPoint): void {
  if (process.env.MODEL_COMPASS_FAULT_INJECT === point) {
    throw new SyncFailure(
      "injected_fault",
      `Injected fault at ${point} (test only).`
    );
  }
}

function classifyUpstreamError(err: unknown): SyncFailure {
  if (err instanceof SyncFailure) return err;
  if (err instanceof AAApiError) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return new SyncFailure(
        "upstream_auth",
        "Artificial Analysis authentication/authorization failed."
      );
    }
    if (err.statusCode === 429) {
      return new SyncFailure(
        "upstream_rate_limited",
        "Artificial Analysis rate limit exhausted."
      );
    }
    return new SyncFailure(
      "upstream_error",
      `Artificial Analysis request failed (HTTP ${err.statusCode ?? "unknown"}).`
    );
  }
  return new SyncFailure(
    "sync_failed",
    err instanceof Error ? err.message : String(err)
  );
}

/**
 * In-transaction lease recheck (design §2.6): the staging and activation
 * write transactions must each verify, on the DB clock, that this owner
 * still holds the lease before writing.
 */
async function assertLeaseHeldInTx(
  tx: { all: (query: ReturnType<typeof sql>) => Promise<unknown[]> },
  owner: string
): Promise<void> {
  const rows = await tx.all(
    sql`SELECT owner FROM sync_locks
        WHERE lock_key = ${SYNC_LOCK_KEY} AND owner = ${owner}
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  );
  if (rows.length !== 1) {
    throw new LeaseLostError();
  }
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

/**
 * Stage a candidate snapshot (Package E publication boundary): dimension
 * upserts, the staging snapshot row and its measurements commit in one
 * short write transaction that first rechecks the lease and the expected
 * active snapshot. The active pointer does NOT move here.
 */
export async function stageSnapshot(params: {
  bundle: NormalizedBundle;
  extras: Map<string, EnrichedMeasurementExtra>;
  source: string;
  indexVersion: string;
  fetchedAt: string;
  isDemo: boolean;
  owner: string;
  expectedActiveSnapshotId: string | null;
}): Promise<{ snapshotId: string; contentHash: string }> {
  const { bundle, extras, source, indexVersion, fetchedAt, isDemo } = params;
  const db = getDb();
  const contentHash = computeBundleContentHash(bundle, indexVersion, extras);
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
  if (params.expectedActiveSnapshotId) {
    const prevRows = await db
      .select()
      .from(benchmarkMeasurements)
      .where(
        eq(benchmarkMeasurements.snapshotId, params.expectedActiveSnapshotId)
      );
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
    await assertLeaseHeldInTx(tx, params.owner);

    const [currentActive] = await tx
      .select()
      .from(dataSnapshots)
      .where(eq(dataSnapshots.status, "active"))
      .orderBy(desc(dataSnapshots.fetchedAt))
      .limit(1);
    if ((currentActive?.id ?? null) !== params.expectedActiveSnapshotId) {
      throw new SyncFailure(
        "active_changed",
        "Active snapshot changed while staging; aborting publication."
      );
    }
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
      // Package D: persist the multi-turn template version per snapshot so
      // API/export can report which template produced the simulated costs.
      templateVersion: MULTI_TURN_TEMPLATE_VERSION,
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

  });

  return { snapshotId, contentHash };
}

/**
 * Activation (Package E): in ONE transaction — recheck the lease, archive
 * the old active snapshot, activate the staged snapshot with its
 * publication record (`published_at` produced by the DB clock in this
 * transaction) and write the job's terminal `success` state. Any failure
 * rolls the whole activation back; readers keep seeing the old complete
 * version.
 */
export async function activateSnapshot(params: {
  snapshotId: string;
  owner: string;
  jobId: string;
  fetchedAt: string;
  exportSha256: string;
  exportPath: string;
  fileGeneratedAt: string;
  sourceDataAt: string | null;
  fetchedCount: number;
  validCount: number;
  rejectedCount: number;
  rateLimitRemaining: number | null;
  rateLimitReset: string | null;
}): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await assertLeaseHeldInTx(tx, params.owner);

    const [staging] = await tx
      .select()
      .from(dataSnapshots)
      .where(eq(dataSnapshots.id, params.snapshotId));
    if (!staging || staging.status !== "staging") {
      throw new SyncFailure(
        "staging_missing",
        "Staged snapshot is missing or no longer in staging state."
      );
    }

    await tx
      .update(dataSnapshots)
      .set({ status: "archived" })
      .where(eq(dataSnapshots.status, "active"));

    await tx
      .update(dataSnapshots)
      .set({
        status: "active",
        publishedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        fileGeneratedAt: params.fileGeneratedAt,
        sourceDataAt: params.sourceDataAt,
        exportSha256: params.exportSha256,
        exportPath: params.exportPath,
        lastVerifiedFetchAt: params.fetchedAt,
      })
      .where(eq(dataSnapshots.id, params.snapshotId));

    const updated = await tx
      .update(syncJobs)
      .set({
        status: "success",
        completedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        fetchedCount: params.fetchedCount,
        validCount: params.validCount,
        rejectedCount: params.rejectedCount,
        rateLimitRemaining: params.rateLimitRemaining,
        rateLimitReset: params.rateLimitReset,
        snapshotId: params.snapshotId,
      })
      .where(and(eq(syncJobs.id, params.jobId), eq(syncJobs.status, "running")))
      .returning({ id: syncJobs.id });
    if (updated.length !== 1) {
      throw new LeaseLostError();
    }
  });
}


/**
 * no_change completion (Package E): the verified fetch advances only the
 * active snapshot's verification clock and the job's terminal state, in
 * one transaction. Snapshot ID, publication time, generation time and
 * export bytes are all preserved.
 */
export async function completeNoChange(params: {
  snapshotId: string;
  owner: string;
  jobId: string;
  fetchedAt: string;
  fetchedCount: number;
  validCount: number;
  rejectedCount: number;
  rateLimitRemaining: number | null;
  rateLimitReset: string | null;
}): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await assertLeaseHeldInTx(tx, params.owner);

    await tx
      .update(dataSnapshots)
      .set({ lastVerifiedFetchAt: params.fetchedAt })
      .where(eq(dataSnapshots.id, params.snapshotId));

    const updated = await tx
      .update(syncJobs)
      .set({
        status: "no_change",
        completedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        fetchedCount: params.fetchedCount,
        validCount: params.validCount,
        rejectedCount: params.rejectedCount,
        rateLimitRemaining: params.rateLimitRemaining,
        rateLimitReset: params.rateLimitReset,
        snapshotId: params.snapshotId,
      })
      .where(and(eq(syncJobs.id, params.jobId), eq(syncJobs.status, "running")))
      .returning({ id: syncJobs.id });
    if (updated.length !== 1) {
      throw new LeaseLostError();
    }
  });
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
  const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  // The lease owner is the job's unique value (design §2.6).
  const owner = jobId;
  const startedAt = new Date().toISOString();
  const apiKey = process.env.AA_API_KEY?.trim() ?? "";
  const isDemo =
    options?.forceDemo === true || process.env.DEMO_MODE === "true";

  if (options?.manual) {
    const cooldownSec = getManualSyncCooldownSeconds();
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
          reasonCode: "cooldown",
          isDemo,
        };
      }
    }
  }

  const locked = await acquireSyncLease(owner);
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
      reasonCode: "locked",
      isDemo,
    };
  }

  // Everything after acquisition — including job registration — is inside
  // try/finally so a registration failure can never strand the lease.
  let renewalTimer: ReturnType<typeof setInterval> | null = null;
  try {
    await db.insert(syncJobs).values({
      id: jobId,
      startedAt,
      status: "running",
      fetchedCount: 0,
      validCount: 0,
      rejectedCount: 0,
      owner,
    });

    // Takeover bookkeeping: holding the single lease proves every other
    // still-running job's owner has lost it. Mark those stranded jobs
    // failed + reason_code="interrupted" (no new status enum).
    await db
      .update(syncJobs)
      .set({
        status: "failed",
        reasonCode: "interrupted",
        completedAt: new Date().toISOString(),
        errorMessage:
          "Interrupted: the job's lease expired and a new sync took over.",
      })
      .where(and(eq(syncJobs.status, "running"), ne(syncJobs.id, jobId)));

    // Renew at TTL/3; a failed renewal means the write transactions'
    // in-transaction rechecks will abort before any activation write.
    const renewalIntervalMs = Math.max(
      10,
      Math.floor((getSyncLockTtlSeconds() * 1000) / 3)
    );
    renewalTimer = setInterval(() => {
      void renewSyncLease(owner).catch(() => undefined);
    }, renewalIntervalMs);
    renewalTimer.unref?.();

    let bundle: NormalizedBundle;
    let source: string;
    let indexVersion: string;
    let fetchedCount: number;
    let rateLimitRemaining: number | null = null;
    let rateLimitReset: string | null = null;

    if (!isDemo) {
      // Data gate (AC-E3): a real sync without a key fails closed. The
      // previous demo fallback / stale-data rebuild paths are removed —
      // demo data may only enter through the explicit demo entry points.
      if (apiKey.length === 0) {
        throw new SyncFailure(
          "missing_api_key",
          "AA_API_KEY is not configured; real sync cannot run and demo fallback is forbidden outside demo mode."
        );
      }
      const tier =
        (process.env.AA_API_TIER as "free" | "pro" | "commercial") ?? "free";
      let aaResult;
      try {
        aaResult = await runArtificialAnalysisAdapter({
          apiKey,
          tier,
          baseUrl: process.env.AA_API_BASE_URL,
          fetchImpl: options?.aaFetchImpl,
        });
      } catch (err) {
        throw classifyUpstreamError(err);
      }
      source = "artificial-analysis";
      indexVersion = aaResult.indexVersion;
      fetchedCount = aaResult.fetchedCount;
      bundle = aaResult.bundle;
      rateLimitRemaining = aaResult.rateLimitRemaining;
      rateLimitReset = aaResult.rateLimitReset;
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

    // Fetch completion time (four-time contract): distinct from job start,
    // publication time and file generation time.
    const fetchedAt = new Date().toISOString();

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
      throw new SyncFailure(
        "empty_result",
        "Normalized measurement set is empty; aborting snapshot commit."
      );
    }

    if (!isDemo) {
      // Data gate: mixed or unknown index versions fail closed.
      if (!indexVersion || indexVersion === "unknown") {
        throw new SyncFailure(
          "unknown_index_version",
          "Upstream index version is unknown; refusing to publish an unverifiable single-version snapshot."
        );
      }
      if (bundle.measurements.some((m) => m.indexVersion !== indexVersion)) {
        throw new SyncFailure(
          "mixed_index_version",
          "Measurement set mixes index versions; aborting snapshot commit."
        );
      }
    }

    const sessionReport = await ingestAllAgentSessions({ windowDays: 30 });
    const extras = computeBundleAgentCosts({
      bundle,
      sessions: sessionReport.sessions,
      sessionSources: sessionReport.sources,
      fetchedAt,
    });

    if (!isDemo) {
      // Data gate: coverage thresholds (provisional 80% basis, E-3).
      const releaseById = new Map(bundle.releases.map((r) => [r.id, r]));
      const variantById = new Map(bundle.variants.map((v) => [v.id, v]));
      const creatorById = new Map(bundle.creators.map((c) => [c.id, c]));
      const counts = countCoverage(
        bundle.measurements.map((m) => {
          const variant = variantById.get(m.variantId);
          const release = variant
            ? releaseById.get(variant.modelReleaseId)
            : undefined;
          const creator = release
            ? creatorById.get(release.creatorId)
            : undefined;
          let estimatedCost: number | null = null;
          const extra = extras.get(m.variantId);
          if (extra) {
            try {
              const parsed = JSON.parse(extra.agentCostJson) as {
                estimated_cost?: unknown;
              };
              estimatedCost =
                typeof parsed.estimated_cost === "number"
                  ? parsed.estimated_cost
                  : null;
            } catch {
              estimatedCost = null;
            }
          }
          return {
            intelligenceScore: m.intelligenceScore,
            creatorSlug: creator?.slug ?? "",
            estimatedCost,
          };
        })
      );
      const gate = evaluateCoverage(counts);
      if (!gate.ok) {
        throw new SyncFailure(
          "coverage_below_minimum",
          `Coverage gate failed: ${gate.failures.join("; ")}.`
        );
      }
    }

    const validCount = bundle.measurements.length;
    const rejectedCount =
      bundle.rejectedCount + sessionReport.rejectedCount;
    const contentHash = computeBundleContentHash(bundle, indexVersion, extras);

    const [activeSnapshot] = await db
      .select()
      .from(dataSnapshots)
      .where(eq(dataSnapshots.status, "active"))
      .orderBy(desc(dataSnapshots.fetchedAt))
      .limit(1);

    const hasPublicationRecord = Boolean(
      activeSnapshot?.exportSha256 && activeSnapshot?.exportPath
    );

    if (
      activeSnapshot &&
      hasPublicationRecord &&
      activeSnapshot.contentHash === contentHash &&
      activeSnapshot.source === source &&
      activeSnapshot.isDemo === isDemo
    ) {
      // no_change: the registered publication file must verify against
      // the DB record, otherwise fail closed and keep the old version.
      const bytes = readPublicationFile(activeSnapshot.exportPath as string);
      if (!bytes || sha256Hex(bytes) !== activeSnapshot.exportSha256) {
        throw new SyncFailure(
          "publication_file_mismatch",
          "Registered publication file is missing or its digest does not match the DB publication record; keeping the old active version."
        );
      }
      await completeNoChange({
        snapshotId: activeSnapshot.id,
        owner,
        jobId,
        fetchedAt,
        fetchedCount,
        validCount,
        rejectedCount,
        rateLimitRemaining,
        rateLimitReset,
      });
      // Idempotent distribution repair from the verified bytes; the
      // version file, snapshot ID and generation time stay untouched.
      // The no_change terminal state has already committed at this point,
      // so a distribution failure must not flip the reported outcome: it
      // is flagged as pending and repaired by a later run.
      let distributionPending = false;
      try {
        writeDistributionCopies({
          serialized: bytes,
          dateTag: (activeSnapshot.fileGeneratedAt ?? fetchedAt).slice(0, 10),
        });
      } catch (distErr) {
        distributionPending = true;
        console.warn(
          `Distribution copy write failed after no_change commit for snapshot ${activeSnapshot.id}; will repair on a later run.`,
          distErr
        );
      }
      return {
        jobId,
        status: "no_change",
        snapshotId: activeSnapshot.id,
        fetchedCount,
        validCount,
        rejectedCount,
        rateLimitRemaining,
        rateLimitReset,
        distributionPending,
        isDemo,
      };
    }

    // A legacy active snapshot without a publication record always goes
    // through the full publication path, even for identical content.
    const { snapshotId } = await stageSnapshot({
      bundle,
      extras,
      source,
      indexVersion,
      fetchedAt,
      isDemo,
      owner,
      expectedActiveSnapshotId: activeSnapshot?.id ?? null,
    });

    maybeInjectFault("after_staging");

    const stagedData = await getActiveMeasurements(snapshotId);
    const fileGeneratedAt = new Date().toISOString();
    const payload = buildStandardizedExportPayload({
      rows: stagedData.rows,
      indexVersion,
      generatedAt: fileGeneratedAt,
      isDemo,
      snapshotId,
      fetchedAt,
      // AA exposes no trustworthy upstream data timestamp; the release
      // date is a separate field and must not substitute (design §2.6).
      sourceDataAt: null,
    });

    maybeInjectFault("export_write");
    const publication = writeImmutablePublicationFile({ snapshotId, payload });
    maybeInjectFault("before_activation");

    await activateSnapshot({
      snapshotId,
      owner,
      jobId,
      fetchedAt,
      exportSha256: publication.sha256,
      exportPath: publication.relativePath,
      fileGeneratedAt,
      sourceDataAt: null,
      fetchedCount,
      validCount,
      rejectedCount,
      rateLimitRemaining,
      rateLimitReset,
    });

    // The activation transaction has committed (job terminal state is
    // success, publication is live). Distribution copies are a separate,
    // repairable step: a failure here must NOT be reported as a failed
    // sync — flag it as pending; a later no_change run repairs the copies
    // from the verified publication bytes.
    let distributionPending = false;
    try {
      maybeInjectFault("after_activation");

      writeDistributionCopies({
        serialized: publication.serialized,
        dateTag: fileGeneratedAt.slice(0, 10),
      });
    } catch (distErr) {
      distributionPending = true;
      console.warn(
        `Distribution copy write failed after activation of snapshot ${snapshotId}; publication is live, copies pending repair.`,
        distErr
      );
    }

    return {
      jobId,
      status: "success",
      snapshotId,
      fetchedCount,
      validCount,
      rejectedCount,
      rateLimitRemaining,
      rateLimitReset,
      distributionPending,
      isDemo,
    };
  } catch (err) {
    const failure = classifyUpstreamError(err);
    // Only a still-running job may be marked failed here: a job whose
    // activation already committed keeps its success terminal state.
    await db
      .update(syncJobs)
      .set({
        completedAt: new Date().toISOString(),
        status: "failed",
        errorMessage: failure.message,
        reasonCode: failure.reasonCode,
      })
      .where(and(eq(syncJobs.id, jobId), eq(syncJobs.status, "running")));

    return {
      jobId,
      status: "failed",
      fetchedCount: 0,
      validCount: 0,
      rejectedCount: 0,
      rateLimitRemaining: null,
      rateLimitReset: null,
      errorMessage: failure.message,
      reasonCode: failure.reasonCode,
      isDemo,
    };
  } finally {
    if (renewalTimer) clearInterval(renewalTimer);
    await releaseSyncLease(owner).catch(() => undefined);
  }
}
