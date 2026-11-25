import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeasurementRow } from "@/lib/analytics/types";
import { calculateEAC, DEFAULT_AGENT_PARAMS } from "@/lib/agent-cost/eac";
import { getDeveloperAgentCost } from "@/lib/utils/format";

vi.mock("@/lib/database/queries", () => ({
  getActiveMeasurements: vi.fn(),
}));

import { GET } from "@/app/api/frontier/route";
import { getActiveMeasurements } from "@/lib/database/queries";

const mockedGet = vi.mocked(getActiveMeasurements);

const SNAPSHOT = {
  id: "snap-1",
  benchmarkVersion: "4.0",
} as Awaited<ReturnType<typeof getActiveMeasurements>>["snapshot"];

function makeRow(overrides: Partial<MeasurementRow> = {}): MeasurementRow {
  return {
    id: "m1",
    variantId: "v1",
    releaseId: "r1",
    creatorId: "c1",
    creatorName: "OpenAI",
    creatorSlug: "openai",
    creatorColor: "#000000",
    family: "GPT",
    releaseName: "Model One",
    releaseDate: "2026-01-01",
    contextWindow: 128_000,
    isOpenWeights: false,
    sourceUrl: "https://example.com",
    sourceSlug: "model-one-high",
    rawName: "Model One High",
    displayName: "Model One High",
    effortRaw: "High",
    effortNormalized: "High",
    effortOrder: 3,
    effortLadderType: "single",
    isReasoningModel: true,
    isGrouped: false,
    source: "artificial-analysis",
    indexName: "AA",
    indexVersion: "4.0",
    intelligenceScore: 50,
    codingScore: 50,
    agenticScore: 50,
    inputPricePerMillion: 1,
    outputPricePerMillion: 4,
    cacheReadPricePerMillion: null,
    cacheWritePricePerMillion: null,
    outputTokensPerSecond: null,
    timeToFirstToken: null,
    timePerTask: null,
    measuredAt: null,
    fetchedAt: "2026-11-26T00:00:00Z",
    pricingSource: "aa",
    snapshotId: "snap-1",
    agentUsage: {
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
    },
    agentCost: {
      p25: null,
      p50: null,
      p75: null,
      p90: null,
      mean: null,
      effective_cost: null,
      rasc: null,
      estimated_cost: null,
      extra_tool_cost_mean: null,
    },
    dataQuality: {
      level: "C",
      source_type: "estimated",
      sources: ["test"],
      updated_at: null,
    } as MeasurementRow["dataQuality"],
    ...overrides,
  };
}

function setRows(rows: MeasurementRow[]) {
  mockedGet.mockResolvedValue({ snapshot: SNAPSHOT, rows });
}

async function callFrontier(query: string) {
  const res = await GET(new Request(`http://localhost/api/frontier?${query}`));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("frontier route: measured modes", () => {
  it("zero qualified samples -> 200 with an empty frontier (AC-D4)", async () => {
    setRows([makeRow(), makeRow({ id: "m2", variantId: "v2" })]);
    const { status, body } = await callFrontier("");
    expect(status).toBe(200);
    expect(body.frontier).toEqual([]);
    expect(body.frontierIds).toEqual([]);
    expect(body.snapshot_id).toBe("snap-1");
    expect(body.cost_mode).toBe("rasc");
    expect(body.cost_unit).toBe("USD/effective task");
  });

  it("qualified zero measured value joins the measured frontier (D-5)", async () => {
    const zero = makeRow({
      agentCost: { ...makeRow().agentCost, rasc: 0 },
      dataQuality: {
        level: "A",
        source_type: "measured_billed",
        sources: ["test"],
        updated_at: null,
      } as MeasurementRow["dataQuality"],
    });
    const positive = makeRow({
      id: "m2",
      variantId: "v2",
      intelligenceScore: 40,
      agentCost: { ...makeRow().agentCost, rasc: 2 },
      dataQuality: {
        level: "B",
        source_type: "measured_token_pricing",
        sources: ["test"],
        updated_at: null,
      } as MeasurementRow["dataQuality"],
    });
    // C-grade row carrying a RASC value must never leak into measured mode.
    const unqualified = makeRow({
      id: "m3",
      variantId: "v3",
      intelligenceScore: 90,
      agentCost: { ...makeRow().agentCost, rasc: 0.5 },
    });
    setRows([zero, positive, unqualified]);
    const { status, body } = await callFrontier("xMode=rasc");
    expect(status).toBe(200);
    expect(body.frontierIds).toContain("m1");
    expect(body.frontierIds).not.toContain("m3");
    const zeroPoint = body.frontier.find((p: { id: string }) => p.id === "m1");
    expect(zeroPoint.cost).toBe(0);
  });

  it("measured mode has no fallback to estimates when RASC is missing", async () => {
    const row = makeRow({
      dataQuality: {
        level: "A",
        source_type: "measured_billed",
        sources: ["test"],
        updated_at: null,
      } as MeasurementRow["dataQuality"],
      agentCost: { ...makeRow().agentCost, rasc: null, estimated_cost: 0.5 },
    });
    setRows([row]);
    const { status, body } = await callFrontier("xMode=rasc");
    expect(status).toBe(200);
    expect(body.frontier).toEqual([]);
  });

  it("P50 mode is labelled USD/session and uses only the P50 value", async () => {
    const row = makeRow({
      dataQuality: {
        level: "B",
        source_type: "measured_token_pricing",
        sources: ["test"],
        updated_at: null,
      } as MeasurementRow["dataQuality"],
      agentCost: { ...makeRow().agentCost, p50: 1.5, rasc: 0.25 },
    });
    setRows([row]);
    const { status, body } = await callFrontier("xMode=real_p50");
    expect(status).toBe(200);
    expect(body.cost_unit).toBe("USD/session");
    expect(body.frontier[0].cost).toBe(1.5);
  });
});

describe("frontier route: estimated modes", () => {
  it("eac points equal the single template calculation row by row, ignoring RASC", async () => {
    const a = makeRow({
      dataQuality: {
        level: "A",
        source_type: "measured_billed",
        sources: ["test"],
        updated_at: null,
      } as MeasurementRow["dataQuality"],
      agentCost: { ...makeRow().agentCost, rasc: 999 },
    });
    const d = makeRow({
      id: "m2",
      variantId: "v2",
      intelligenceScore: 70,
      inputPricePerMillion: 3,
      dataQuality: {
        level: "D",
        source_type: "unavailable",
        sources: [],
        updated_at: null,
      } as MeasurementRow["dataQuality"],
    });
    setRows([a, d]);
    const { status, body } = await callFrontier("xMode=eac");
    expect(status).toBe(200);
    expect(body.cost_unit).toBe("USD/simulated task");
    expect(body.task_profile).toBe("standard");
    expect(body.template_version).toBe("mt-v2");
    const costs = Object.fromEntries(
      body.frontier.map((p: { id: string; cost: number }) => [p.id, p.cost])
    );
    // Both rows are on the frontier (different cost/score trade-off) and
    // each amount is exactly the template calculation for that row.
    expect(costs.m1).toBe(getDeveloperAgentCost(a, "standard")!.totalUsd);
    expect(costs.m1).toBe(0.99864);
    expect(costs.m2).toBe(getDeveloperAgentCost(d, "standard")!.totalUsd);
    // No measured grade is passed into the frontier computation.
    for (const p of body.frontier) {
      expect(p.qualityLevel).toBeUndefined();
    }
    expect(
      body.frontier.find((p: { id: string }) => p.id === "m2").sourceQualityLevel
    ).toBe("D");
  });

  it("eac taskProfile selects the tier; omitted equals explicit standard; other modes ignore it", async () => {
    const row = makeRow();
    setRows([row]);
    const def = await callFrontier("xMode=eac");
    const std = await callFrontier("xMode=eac&taskProfile=standard");
    const heavy = await callFrontier("xMode=eac&taskProfile=heavy");
    expect(def.body.frontier[0].cost).toBe(std.body.frontier[0].cost);
    expect(heavy.body.frontier[0].cost).toBe(
      getDeveloperAgentCost(row, "heavy")!.totalUsd
    );
    expect(heavy.body.task_profile).toBe("heavy");
    // taskProfile on a non-eac mode is ignored, not an error.
    const rasc = await callFrontier("xMode=rasc&taskProfile=heavy");
    expect(rasc.status).toBe(200);
    expect(rasc.body.task_profile).toBeNull();
  });

  it("custom_agent uses the legacy template and never stacks measured tool cost", async () => {
    const row = makeRow({
      agentCost: { ...makeRow().agentCost, extra_tool_cost_mean: 7 },
    });
    setRows([row]);
    const { status, body } = await callFrontier("xMode=custom_agent");
    expect(status).toBe(200);
    expect(body.template_version).toBe("legacy-v1");
    const expected = calculateEAC(
      {
        inputPerMillion: 1,
        outputPerMillion: 4,
        cacheReadPerMillion: null,
        cacheWritePerMillion: null,
        currency: "USD",
      },
      DEFAULT_AGENT_PARAMS
    );
    expect(body.frontier[0].cost).toBe(expected!.estimatedCostUsd);
  });

  it("mixed A/B/C/D rows and mixed index versions do not throw; off-version rows are excluded", async () => {
    const levels = ["A", "B", "C", "D"] as const;
    const rows = levels.map((level, i) =>
      makeRow({
        id: `m${i}`,
        variantId: `v${i}`,
        intelligenceScore: 40 + i * 10,
        inputPricePerMillion: 1 + i,
        dataQuality: {
          level,
          source_type: "estimated",
          sources: ["test"],
          updated_at: null,
        } as MeasurementRow["dataQuality"],
      })
    );
    const offVersion = makeRow({
      id: "mOff",
      variantId: "vOff",
      indexVersion: "3.0",
      intelligenceScore: 99,
      inputPricePerMillion: 0.1,
    });
    setRows([...rows, offVersion]);
    const { status, body } = await callFrontier("xMode=eac");
    expect(status).toBe(200);
    expect(body.frontierIds).not.toContain("mOff");
    expect(body.evaluatedCount).toBe(4);
  });

  it("missing price excludes the row from eac; zero price excludes simulated but is kept on pricing axes", async () => {
    const missing = makeRow({ id: "mMiss", variantId: "vMiss", inputPricePerMillion: null });
    const zero = makeRow({
      id: "mZero",
      variantId: "vZero",
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      intelligenceScore: 60,
    });
    setRows([missing, zero]);
    const eac = await callFrontier("xMode=eac");
    expect(eac.status).toBe(200);
    expect(eac.body.frontier).toEqual([]);
    const pricing = await callFrontier("xMode=input_price");
    expect(pricing.status).toBe(200);
    expect(pricing.body.cost_unit).toBe("USD/million tokens");
    expect(pricing.body.frontier).toHaveLength(1);
    expect(pricing.body.frontier[0].id).toBe("mZero");
    expect(pricing.body.frontier[0].cost).toBe(0);
  });
});

describe("frontier route: request compatibility and errors", () => {
  it("illegal parameters return 400 without touching the database", async () => {
    setRows([makeRow()]);
    for (const q of ["xMode=bogus", "yMetric=bogus", "xMode=eac&taskProfile=bogus", "xMode=eac&taskProfile="]) {
      const { status } = await callFrontier(q);
      expect(status).toBe(400);
    }
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("unknown keys are ignored, duplicates take the last value, empty vendor is unrestricted, unknown slug is an empty set", async () => {
    setRows([makeRow()]);
    const unknownKey = await callFrontier("xMode=eac&nonsense=1");
    expect(unknownKey.status).toBe(200);
    expect(unknownKey.body.frontier).toHaveLength(1);

    const dup = await callFrontier("xMode=rasc&xMode=eac");
    expect(dup.status).toBe(200);
    expect(dup.body.cost_mode).toBe("eac");

    const emptyVendor = await callFrontier("xMode=eac&creator=");
    expect(emptyVendor.status).toBe(200);
    expect(emptyVendor.body.candidate_scope).toBe("all");
    expect(emptyVendor.body.frontier).toHaveLength(1);

    const unknownSlug = await callFrontier("xMode=eac&creator=nope");
    expect(unknownSlug.status).toBe(200);
    expect(unknownSlug.body.frontier).toEqual([]);
    expect(unknownSlug.body.candidate_scope).toEqual(["nope"]);

    const scoped = await callFrontier("xMode=eac&creator= OpenAI ,openai");
    expect(scoped.status).toBe(200);
    expect(scoped.body.candidate_scope).toEqual(["openai"]);
    expect(scoped.body.frontier).toHaveLength(1);
  });

  it("schema incompatibility returns a controlled 503", async () => {
    const err = new Error("database is at schema version 0");
    err.name = "SchemaCompatibilityError";
    mockedGet.mockRejectedValue(err);
    const { status, body } = await callFrontier("xMode=eac");
    expect(status).toBe(503);
    expect(body.code).toBe("SCHEMA_INCOMPATIBLE");
    expect(JSON.stringify(body)).not.toContain("schema version 0");
  });

  it("no active snapshot returns a controlled 503", async () => {
    mockedGet.mockResolvedValue({ snapshot: null, rows: [] });
    const { status, body } = await callFrontier("");
    expect(status).toBe(503);
    expect(body.code).toBe("NO_ACTIVE_SNAPSHOT");
  });

  it("unexpected errors return a desensitized 500", async () => {
    mockedGet.mockRejectedValue(
      new Error("SQLITE_CANTOPEN /secret/path/frontier.db?key=hunter2")
    );
    const { status, body } = await callFrontier("xMode=eac");
    expect(status).toBe(500);
    const text = JSON.stringify(body);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("/secret/path");
    expect(text).not.toContain("SQLITE");
  });
});
