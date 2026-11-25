import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapAAModelsToNormalized, type NormalizedBundle } from "@/lib/data-sources/artificial-analysis/mapper";
import type { AAModelItem } from "@/lib/data-sources/artificial-analysis/schema";
import { enrichWithLiteLLMPricing } from "@/lib/data-sources/pricing/litellm-adapter";
import { enrichWithOpenRouter } from "@/lib/data-sources/openrouter/adapter";
import { ingestAllAgentSessions } from "@/lib/data-sources/agent-sessions";
import type { VerifiedChannelMapping } from "@/lib/data-sources/model-mappings";
import { classifyDataQuality, getSampleWindowExpiry } from "@/lib/agent-cost/quality";
import {
  computeRealAgentStatsAndRasc,
  computeSampleSetDigest,
} from "@/lib/agent-cost/rasc";
import type {
  AgentCostSummary,
  AgentUsageSummary,
  RawAgentSessionRecord,
  TokenPricing,
} from "@/lib/agent-cost/types";
import { computeBundleContentHash, type EnrichedMeasurementExtra } from "@/lib/sync/engine";

const PRICING: TokenPricing = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
  currency: "USD",
};

function makeBundle(pricing?: AAModelItem["pricing"]): NormalizedBundle {
  const item: AAModelItem = {
    id: "aa-model-x",
    name: "Model X (Low)",
    slug: "model-x-low",
    release_date: "2026-01-01",
    model_creator: { name: "Acme", slug: "acme" },
    evaluations: { artificial_analysis_intelligence_index: 50 },
    pricing: pricing ?? { price_1m_output_tokens: 2 },
  };
  return mapAAModelsToNormalized({
    items: [item],
    indexVersion: "5",
    fetchedAt: "2026-07-01T00:00:00Z",
  });
}

const VERIFIED_LITELLM: VerifiedChannelMapping = {
  channel: "litellm",
  creatorSlug: "acme",
  releaseName: "Model X",
  releaseDate: "2026-01-01",
  upstreamKey: "acme/model-x",
  verifiedBy: "data-maintainer",
};

function litellmFetch(catalog: Record<string, unknown>): typeof fetch {
  return async () =>
    new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

describe("Package C: AA mapper price validation", () => {
  it("preserves zero prices, rejects negative/non-finite prices without writing 0, and marks pure-cache pricing source", () => {
    const bundle = makeBundle({
      price_1m_input_tokens: -5,
      price_1m_output_tokens: 0,
      price_1m_cache_read_tokens: 0.25,
    });
    const m = bundle.measurements[0];
    expect(m.inputPricePerMillion).toBeNull();
    expect(m.outputPricePerMillion).toBe(0);
    expect(m.cacheReadPricePerMillion).toBe(0.25);
    expect(m.pricingSource).toBe("artificial-analysis");
    // Missing field has NO provenance entry; priced fields do.
    expect(m.fieldSources?.input).toBeUndefined();
    expect(m.fieldSources?.output?.source).toBe("artificial-analysis");
    expect(m.fieldSources?.output?.observedAt).toBeNull();
  });
});

describe("Package C: verified-mapping-only price filling", () => {
  const catalog = {
    "acme/model-x": {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000099,
      litellm_provider: "acme",
      mode: "chat",
    },
    "other/model-x": {
      input_cost_per_token: 0.000111,
      litellm_provider: "other",
      mode: "chat",
    },
  };

  it("does not fill anything without a verified mapping, regardless of name similarity or candidate order", async () => {
    const bundle = makeBundle();
    const res = await enrichWithLiteLLMPricing(bundle, {
      fetchImpl: litellmFetch(catalog),
      mappings: [],
    });
    expect(res.enrichedMeasurements).toBe(0);
    expect(bundle.measurements[0].inputPricePerMillion).toBeNull();
  });

  it("fills only empty fields from the single verified upstream key and records provenance", async () => {
    const bundle = makeBundle();
    const res = await enrichWithLiteLLMPricing(bundle, {
      fetchImpl: litellmFetch(catalog),
      mappings: [VERIFIED_LITELLM],
    });
    expect(res.enrichedMeasurements).toBe(1);
    const m = bundle.measurements[0];
    expect(m.inputPricePerMillion).toBe(3);
    // AA's own output price (2) is never overwritten by the catalog (99).
    expect(m.outputPricePerMillion).toBe(2);
    expect(m.fieldSources?.input).toMatchObject({
      source: "litellm",
      upstreamKey: "acme/model-x",
      currency: "USD",
      unit: "USD_per_million_tokens",
      observedAt: null,
    });
    expect(m.fieldSources?.output?.source).toBe("artificial-analysis");
  });

  it("is invariant to catalog candidate ordering", async () => {
    const reversed = Object.fromEntries(Object.entries(catalog).reverse());
    const b1 = makeBundle();
    const b2 = makeBundle();
    await enrichWithLiteLLMPricing(b1, { fetchImpl: litellmFetch(catalog), mappings: [VERIFIED_LITELLM] });
    await enrichWithLiteLLMPricing(b2, { fetchImpl: litellmFetch(reversed), mappings: [VERIFIED_LITELLM] });
    expect(b2.measurements[0].inputPricePerMillion).toBe(b1.measurements[0].inputPricePerMillion);
  });

  it("leaves fields empty on ambiguous mappings or wrong-vendor mappings", async () => {
    const ambiguous = makeBundle();
    await enrichWithLiteLLMPricing(ambiguous, {
      fetchImpl: litellmFetch(catalog),
      mappings: [
        VERIFIED_LITELLM,
        { ...VERIFIED_LITELLM, upstreamKey: "other/model-x" },
      ],
    });
    expect(ambiguous.measurements[0].inputPricePerMillion).toBeNull();

    const wrongVendor = makeBundle();
    await enrichWithLiteLLMPricing(wrongVendor, {
      fetchImpl: litellmFetch(catalog),
      mappings: [{ ...VERIFIED_LITELLM, creatorSlug: "other" }],
    });
    expect(wrongVendor.measurements[0].inputPricePerMillion).toBeNull();
  });

  it("rejects invalid catalog prices (negative, overflow, rounding to zero) without writing 0", async () => {
    const bundle = makeBundle();
    await enrichWithLiteLLMPricing(bundle, {
      fetchImpl: litellmFetch({
        "acme/model-x": {
          input_cost_per_token: -0.000003,
          cache_read_input_token_cost: 1e-13, // non-zero but rounds to 0 per million at 6dp
          litellm_provider: "acme",
          mode: "chat",
        },
      }),
      mappings: [VERIFIED_LITELLM],
    });
    expect(bundle.measurements[0].inputPricePerMillion).toBeNull();
    expect(bundle.measurements[0].cacheReadPricePerMillion).toBeNull();
  });

  it("OpenRouter fills only via verified id mapping and strictly parses prices", async () => {
    const orFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "acme/model-x",
              name: "Acme: Model X",
              context_length: 4096,
              pricing: { prompt: "0.000004", completion: " ", input_cache_read: "abc" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const unmapped = makeBundle();
    const r0 = await enrichWithOpenRouter(unmapped, { fetchImpl: orFetch, mappings: [] });
    expect(r0.enrichedPricing).toBe(0);
    expect(unmapped.measurements[0].inputPricePerMillion).toBeNull();

    const bundle = makeBundle();
    // Release starts with a context window from AA? AA item has none, so the
    // verified OpenRouter context may fill it.
    const res = await enrichWithOpenRouter(bundle, {
      fetchImpl: orFetch,
      mappings: [{ ...VERIFIED_LITELLM, channel: "openrouter" }],
    });
    expect(res.enrichedPricing).toBe(1);
    expect(bundle.measurements[0].inputPricePerMillion).toBe(4);
    expect(bundle.measurements[0].fieldSources?.input).toMatchObject({
      source: "openrouter",
      upstreamKey: "acme/model-x",
    });
    // Blank-string and non-decimal prices are rejected, never coerced to 0.
    expect(bundle.measurements[0].outputPricePerMillion).toBe(2); // AA value kept
    expect(bundle.measurements[0].cacheReadPricePerMillion).toBeNull();
  });
});

function usageFixture(overrides: Partial<AgentUsageSummary> = {}): AgentUsageSummary {
  return {
    sample_count: 30,
    independent_user_count: 5,
    avg_input_tokens: 1000,
    avg_output_tokens: 500,
    avg_reasoning_tokens: 100,
    avg_cache_hit_rate: 0.5,
    avg_api_calls: 3,
    success_rate: 0.9,
    time_range_start: "2026-06-29T00:00:00Z",
    time_range_end: "2026-06-30T00:00:00Z",
    scenario_statistics: [],
    ...overrides,
  };
}

function costFixture(overrides: Partial<AgentCostSummary> = {}): AgentCostSummary {
  return {
    p25: 0.01,
    p50: 0.02,
    p75: 0.03,
    p90: 0.04,
    mean: 0.02,
    effective_cost: 0.025,
    rasc: 0.025,
    estimated_cost: 0.4,
    extra_tool_cost_mean: null,
    ...overrides,
  };
}

const NOW = "2026-06-30T12:00:00Z";

describe("Package C: quality grading, mixed sources and rolling expiry", () => {
  it("grades a complete verified-billed group as A / measured_billed", () => {
    const q = classifyDataQuality({
      usage: usageFixture(),
      cost: costFixture(),
      pricing: PRICING,
      hasActualBilledSessions: true,
      allSessionsBilled: true,
      sources: ["otel:verified"],
      updatedAt: NOW,
      now: NOW,
    });
    expect(q.level).toBe("A");
    expect(q.source_type).toBe("measured_billed");
    expect(q.measured_eligible_rasc).toBe(true);
    expect(q.measured_eligible_p50).toBe(true);
    expect(q.sample_window_expires_at).toBe("2026-07-29T00:00:00.000Z");
  });

  it("grades mixed billed + token-priced groups as B with the strict mixed enum and breakdown fields", () => {
    const q = classifyDataQuality({
      usage: usageFixture(),
      cost: costFixture(),
      pricing: PRICING,
      hasActualBilledSessions: true,
      allSessionsBilled: false,
      sources: ["otel:verified"],
      updatedAt: NOW,
      now: NOW,
      billedSampleCount: 12,
      tokenPricedSampleCount: 18,
      billedAmountUsd: 0.24,
      tokenPricedAmountUsd: 0.19,
      verifiedEffort: "High",
    });
    expect(q.level).toBe("B");
    expect(q.source_type).toBe("measured_mixed");
    expect(q.billed_sample_count).toBe(12);
    expect(q.token_priced_sample_count).toBe(18);
    expect(q.billed_amount_usd).toBe(0.24);
    expect(q.token_priced_amount_usd).toBe(0.19);
    // Verified tier and observed tokens are separate fields.
    expect(q.verified_effort).toBe("High");
    expect(q.observed_tokens?.avg_input).toBe(1000);
  });

  it("grades token-priced-only groups as B / measured_token_pricing", () => {
    const q = classifyDataQuality({
      usage: usageFixture(),
      cost: costFixture(),
      pricing: PRICING,
      hasActualBilledSessions: false,
      allSessionsBilled: false,
      sources: ["otel:verified"],
      updatedAt: NOW,
      now: NOW,
    });
    expect(q.level).toBe("B");
    expect(q.source_type).toBe("measured_token_pricing");
  });

  it("fails closed below the 30-sample / 5-user thresholds", () => {
    const lowSamples = classifyDataQuality({
      usage: usageFixture({ sample_count: 29 }),
      cost: costFixture(),
      pricing: PRICING,
      hasActualBilledSessions: true,
      allSessionsBilled: true,
      sources: ["otel:verified"],
      updatedAt: NOW,
      now: NOW,
    });
    expect(lowSamples.level).toBe("C");
    expect(lowSamples.low_sample_warning).toBe(true);
    expect(lowSamples.measured_eligible_rasc).toBe(false);

    const lowUsers = classifyDataQuality({
      usage: usageFixture({ independent_user_count: 4 }),
      cost: costFixture(),
      pricing: PRICING,
      hasActualBilledSessions: true,
      allSessionsBilled: true,
      sources: ["otel:verified"],
      updatedAt: NOW,
      now: NOW,
    });
    expect(lowUsers.level).toBe("C");
  });

  it("expires measured eligibility at earliest sample + 30 days (UTC) and fails closed on missing/future timestamps", () => {
    expect(getSampleWindowExpiry(usageFixture(), 30)).toBe(
      Date.parse("2026-07-29T00:00:00Z")
    );
    const expired = classifyDataQuality({
      usage: usageFixture(),
      cost: costFixture(),
      pricing: PRICING,
      hasActualBilledSessions: true,
      allSessionsBilled: true,
      sources: ["otel:verified"],
      updatedAt: NOW,
      now: "2026-07-29T00:00:01Z",
    });
    expect(expired.level).toBe("C");
    expect(expired.is_stale).toBe(true);

    const missing = classifyDataQuality({
      usage: usageFixture({ time_range_start: null, time_range_end: null }),
      cost: costFixture(),
      pricing: PRICING,
      hasActualBilledSessions: true,
      allSessionsBilled: true,
      sources: ["otel:verified"],
      updatedAt: NOW,
      now: NOW,
    });
    expect(missing.level).toBe("C");
    expect(missing.measured_eligible_p50).toBe(false);

    const future = classifyDataQuality({
      usage: usageFixture({
        time_range_start: "2026-06-30T00:00:00Z",
        time_range_end: "2026-07-02T00:00:00Z", // > 1 day beyond now
      }),
      cost: costFixture(),
      pricing: PRICING,
      hasActualBilledSessions: true,
      allSessionsBilled: true,
      sources: ["otel:verified"],
      updatedAt: NOW,
      now: NOW,
    });
    expect(future.level).toBe("C");
  });
});

describe("Package C: sample-set digest and content hash sensitivity", () => {
  it("sample digest changes when the sample set changes but aggregates stay equal, and is order-stable", () => {
    const base = [
      { sessionId: "s1", timestamp: "2026-06-29T00:00:00Z", succeeded: true, scenario: "bug_fix", costUsd: 0.02 },
      { sessionId: "s2", timestamp: "2026-06-29T01:00:00Z", succeeded: false, scenario: "bug_fix", costUsd: 0.02 },
    ];
    const swapped = [
      base[0],
      { sessionId: "s3", timestamp: "2026-06-29T01:00:00Z", succeeded: false, scenario: "bug_fix", costUsd: 0.02 },
    ];
    expect(computeSampleSetDigest(base)).not.toBe(computeSampleSetDigest(swapped));
    expect(computeSampleSetDigest([...base].reverse())).toBe(computeSampleSetDigest(base));
  });

  it("content hash is stable for identical input and changes when only the source changes", () => {
    const bundle = makeBundle();
    const extra = (fieldSourcesJson: string, digest: string): EnrichedMeasurementExtra => ({
      agentUsageJson: "{}",
      agentCostJson: "{}",
      dataQualityLevel: "D",
      dataSourceType: "unavailable",
      dataSourcesJson: "[]",
      dataUpdatedAt: "2026-07-01T00:00:00Z",
      fieldSourcesJson,
      sampleSetDigest: digest,
    });
    const v = bundle.measurements[0].variantId;
    const h1 = computeBundleContentHash(bundle, "5", new Map([[v, extra('{"input":{"source":"litellm"}}', "digest-a")]]));
    const h2 = computeBundleContentHash(bundle, "5", new Map([[v, extra('{"input":{"source":"litellm"}}', "digest-a")]]));
    const h3 = computeBundleContentHash(bundle, "5", new Map([[v, extra('{"input":{"source":"openrouter"}}', "digest-a")]]));
    const h4 = computeBundleContentHash(bundle, "5", new Map([[v, extra('{"input":{"source":"litellm"}}', "digest-b")]]));
    expect(h1).toBe(h2);
    expect(h3).not.toBe(h1);
    expect(h4).not.toBe(h1);
  });

  it("RASC result carries the mixed breakdown counts", () => {
    const now = new Date().toISOString();
    const sessions: RawAgentSessionRecord[] = [
      {
        sessionId: "billed-1",
        userIdHash: "u1",
        modelId: "m1",
        provider: "acme",
        scenario: "bug_fix",
        complexity: "medium",
        succeeded: true,
        actualBilledUsd: 0.5,
        calls: [{ uncachedInputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, billableOutputTokens: 50 }],
        timestamp: now,
        source: "otel:verified",
      },
      {
        sessionId: "token-1",
        userIdHash: "u2",
        modelId: "m1",
        provider: "acme",
        scenario: "bug_fix",
        complexity: "medium",
        succeeded: true,
        calls: [{ uncachedInputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, billableOutputTokens: 50 }],
        timestamp: now,
        source: "otel:verified",
      },
    ];
    const res = computeRealAgentStatsAndRasc({ sessions, pricing: PRICING, minSamplesPerScenario: 1 });
    expect(res.billedSampleCount).toBe(1);
    expect(res.tokenPricedSampleCount).toBe(1);
    expect(res.sampleSetDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("Package C: production session ingestion is zero", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("short-circuits in production config: no loaders, no sessions, disabled status (zero-ingestion sentinel)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ingest-"));
    const otelDir = path.join(dir, "otel");
    const uploadsDir = path.join(dir, "uploads");
    fs.mkdirSync(otelDir, { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    const fakeSession = JSON.stringify([
      {
        sessionId: "planted-1",
        modelId: "m1",
        provider: "acme",
        scenario: "bug_fix",
        complexity: "medium",
        succeeded: true,
        actualBilledUsd: 99,
        calls: [],
        timestamp: new Date().toISOString(),
        source: "user-upload:planted",
      },
    ]);
    fs.writeFileSync(path.join(otelDir, "planted.json"), fakeSession);
    fs.writeFileSync(path.join(uploadsDir, "planted.json"), fakeSession);

    vi.stubEnv("NODE_ENV", "production");
    // Even an explicit enable flag must not open ingestion in production.
    vi.stubEnv("AGENT_SESSION_INGESTION_ENABLED", "true");
    vi.stubEnv("OTEL_SESSIONS_URL", "https://sessions.example.invalid/feed");
    const fetchSpy = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const report = await ingestAllAgentSessions({ otelDir, uploadsDir });
    expect(report.status).toBe("disabled");
    expect(report.sessions).toEqual([]);
    expect(report.rawCount).toBe(0);
    expect(report.validCount).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
