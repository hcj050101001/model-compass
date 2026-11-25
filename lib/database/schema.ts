import {
  sqliteTable,
  text,
  real,
  integer,
  index,
} from "drizzle-orm/sqlite-core";

export const modelCreators = sqliteTable("model_creators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  country: text("country"),
  website: text("website"),
  color: text("color").notNull(),
});

export const modelReleases = sqliteTable(
  "model_releases",
  {
    id: text("id").primaryKey(),
    creatorId: text("creator_id")
      .notNull()
      .references(() => modelCreators.id),
    family: text("family").notNull(),
    name: text("name").notNull(),
    version: text("version"),
    releaseDate: text("release_date"),
    contextWindow: integer("context_window"),
    isOpenWeights: integer("is_open_weights", { mode: "boolean" }),
    sourceUrl: text("source_url"),
  },
  (table) => [index("idx_releases_creator").on(table.creatorId)]
);

export const modelVariants = sqliteTable(
  "model_variants",
  {
    id: text("id").primaryKey(),
    modelReleaseId: text("model_release_id")
      .notNull()
      .references(() => modelReleases.id),
    sourceId: text("source_id").notNull(),
    sourceSlug: text("source_slug").notNull(),
    rawName: text("raw_name").notNull(),
    displayName: text("display_name").notNull(),
    effortRaw: text("effort_raw"),
    effortNormalized: text("effort_normalized"),
    effortOrder: integer("effort_order"),
    effortLadderType: text("effort_ladder_type").notNull().default("single"),
    isReasoningModel: integer("is_reasoning_model", { mode: "boolean" }),
    isGrouped: integer("is_grouped", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    index("idx_variants_release").on(table.modelReleaseId),
    index("idx_variants_slug").on(table.sourceSlug),
  ]
);

export const dataSnapshots = sqliteTable(
  "data_snapshots",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    benchmarkVersion: text("benchmark_version").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    modelCount: integer("model_count").notNull(),
    variantCount: integer("variant_count").notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull(), // 'staging' | 'active' | 'archived' | 'failed'
    isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("idx_snapshots_status").on(table.status)]
);

export const benchmarkMeasurements = sqliteTable(
  "benchmark_measurements",
  {
    id: text("id").primaryKey(),
    variantId: text("variant_id")
      .notNull()
      .references(() => modelVariants.id),
    source: text("source").notNull(),
    sourceUrl: text("source_url").notNull(),
    indexName: text("index_name").notNull(),
    indexVersion: text("index_version").notNull(),
    intelligenceScore: real("intelligence_score"),
    codingScore: real("coding_score"),
    agenticScore: real("agentic_score"),
    inputPricePerMillion: real("input_price_per_million"),
    outputPricePerMillion: real("output_price_per_million"),
    cacheReadPricePerMillion: real("cache_read_price_per_million"),
    cacheWritePricePerMillion: real("cache_write_price_per_million"),
    outputTokensPerSecond: real("output_tokens_per_second"),
    timeToFirstToken: real("time_to_first_token"),
    timePerTask: real("time_per_task"),
    measuredAt: text("measured_at"),
    fetchedAt: text("fetched_at").notNull(),
    pricingSource: text("pricing_source"),
    agentUsageJson: text("agent_usage_json"),
    agentCostJson: text("agent_cost_json"),
    dataQualityLevel: text("data_quality_level").notNull().default("D"),
    dataSourceType: text("data_source_type").notNull().default("unavailable"),
    dataSourcesJson: text("data_sources_json"),
    dataUpdatedAt: text("data_updated_at"),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => dataSnapshots.id),
  },
  (table) => [
    index("idx_measurements_snapshot").on(table.snapshotId),
    index("idx_measurements_variant").on(table.variantId),
    index("idx_measurements_version").on(table.indexVersion),
  ]
);

export const syncJobs = sqliteTable("sync_jobs", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(), // 'running' | 'success' | 'no_change' | 'failed'
  fetchedCount: integer("fetched_count").notNull().default(0),
  validCount: integer("valid_count").notNull().default(0),
  rejectedCount: integer("rejected_count").notNull().default(0),
  errorMessage: text("error_message"),
  rateLimitRemaining: integer("rate_limit_remaining"),
  rateLimitReset: text("rate_limit_reset"),
});

export const syncLocks = sqliteTable("sync_locks", {
  lockKey: text("lock_key").primaryKey(),
  lockedAt: text("locked_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  owner: text("owner").notNull(),
});
