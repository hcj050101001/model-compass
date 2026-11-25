import { describe, expect, it } from "vitest";
import { hasEffortGap, parseEffortAndRelease } from "@/lib/normalization/effort";
import { resolveCreator } from "@/lib/normalization/creators";
import { mapAAModelsToNormalized } from "@/lib/data-sources/artificial-analysis/mapper";
import type { AAModelItem } from "@/lib/data-sources/artificial-analysis/schema";

describe("Normalization & Effort Grouping", () => {
  it("parses effort levels and detects unmeasured effort gaps", () => {
    const low = parseEffortAndRelease({
      rawName: "Claude 4.5 Haiku (Non-thinking)",
      slug: "claude-4-5-haiku-non-thinking",
    });
    const med = parseEffortAndRelease({
      rawName: "Claude 4.5 Haiku (Medium)",
      slug: "claude-4-5-haiku-medium",
    });

    expect(low.effortNormalized).toBe("Non-thinking");
    expect(low.baseName).toBe("Claude 4.5 Haiku");
    expect(med.effortNormalized).toBe("Medium");
    expect(med.baseName).toBe("Claude 4.5 Haiku");
    expect(hasEffortGap(low.effortOrder, med.effortOrder, "standard")).toBe(true);
    expect(hasEffortGap(20, 30, "standard")).toBe(false);
  });

  it("preserves null for missing fields (never converts null to 0) and isolates distinct release dates", () => {
    const items: AAModelItem[] = [
      {
        id: "m1",
        name: "Model X (Low)",
        slug: "model-x-low",
        release_date: "2026-01-01",
        model_creator: { name: "NewLab", slug: "newlab" },
        evaluations: {
          artificial_analysis_intelligence_index: null,
        },
        pricing: {
          price_1m_input_tokens: null,
          price_1m_output_tokens: 2.0,
        },
      },
      {
        id: "m2",
        name: "Model X (Low)",
        slug: "model-x-low-v2",
        release_date: "2026-06-01",
        model_creator: { name: "NewLab", slug: "newlab" },
        evaluations: {
          artificial_analysis_intelligence_index: 50,
        },
        pricing: {
          price_1m_input_tokens: 0.5,
          price_1m_output_tokens: 2.0,
        },
      },
    ];

    const bundle = mapAAModelsToNormalized({
      items,
      indexVersion: "5.0",
      fetchedAt: "2026-11-25T00:00:00Z",
    });

    expect(bundle.releases).toHaveLength(2); // Distinct release dates do NOT merge
    expect(bundle.measurements[0].intelligenceScore).toBeNull();
    expect(bundle.measurements[0].inputPricePerMillion).toBeNull();

    const creator = resolveCreator({ name: "NewLab", slug: "newlab" });
    expect(creator.color).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("unifies comma-separated compound effort and fallback qualifiers into one base model", () => {
    const opusHigh = parseEffortAndRelease({
      rawName: "Claude Opus 5.5 (High, Default Fallback)",
      slug: "claude-opus-5-5-high",
    });
    const opusMax = parseEffortAndRelease({
      rawName: "Claude Opus 5.5 (Max, Default Fallback)",
      slug: "claude-opus-5-5",
    });
    const opusNonReasoning = parseEffortAndRelease({
      rawName: "Claude Opus 4.6 (Non-reasoning, High)",
      slug: "claude-opus-4-6",
    });
    const sonnetNonReasoningLow = parseEffortAndRelease({
      rawName: "Claude Sonnet 4.6 (Non-reasoning, Low)",
      slug: "claude-sonnet-4-6-non-reasoning-low-effort",
    });
    const fableMax = parseEffortAndRelease({
      rawName: "Claude Fable 5 (Max, Opus 4.8 Fallback)",
      slug: "claude-fable-5",
    });
    const datedSonnet = parseEffortAndRelease({
      rawName: "Claude 3.5 Sonnet (June '24)",
      slug: "claude-35-sonnet-june-24",
    });

    expect(opusHigh.isGrouped).toBe(true);
    expect(opusHigh.baseName).toBe("Claude Opus 5.5");
    expect(opusHigh.effortNormalized).toBe("High");

    expect(opusMax.isGrouped).toBe(true);
    expect(opusMax.baseName).toBe("Claude Opus 5.5");
    expect(opusMax.effortNormalized).toBe("Max");

    expect(opusNonReasoning.isGrouped).toBe(true);
    expect(opusNonReasoning.baseName).toBe("Claude Opus 4.6");
    expect(opusNonReasoning.effortNormalized).toBe("Non-thinking (High)");

    expect(sonnetNonReasoningLow.isGrouped).toBe(true);
    expect(sonnetNonReasoningLow.baseName).toBe("Claude Sonnet 4.6");
    expect(sonnetNonReasoningLow.effortNormalized).toBe("Non-thinking (Low)");

    expect(fableMax.isGrouped).toBe(true);
    expect(fableMax.baseName).toBe("Claude Fable 5");
    expect(fableMax.effortNormalized).toBe("Max");

    expect(datedSonnet.isGrouped).toBe(false);
    expect(datedSonnet.baseName).toBe("Claude 3.5 Sonnet (June '24)");
  });
});
