import modelMappings from "@/config/model-mappings.json";

export type EffortLadderType = "standard" | "budget" | "special" | "single";

export interface EffortParseResult {
  effortRaw: string | null;
  effortNormalized: string | null;
  effortOrder: number | null;
  effortLadderType: EffortLadderType;
  isReasoningModel: boolean | null;
  isGrouped: boolean;
  baseName: string;
}

interface EffortRule {
  pattern: RegExp;
  normalized: string;
  order: number;
  ladderType: EffortLadderType;
  isReasoning: boolean;
}

const STANDARD_EFFORT_RULES: EffortRule[] = [
  {
    pattern: /\((?:non-?thinking|non-?reasoning|no[- ]?thinking|none)\)\s*$/i,
    normalized: "Non-thinking",
    order: 0,
    ladderType: "standard",
    isReasoning: false,
  },
  {
    pattern: /\((?:minimal(?:\s+effort)?)\)\s*$/i,
    normalized: "Minimal",
    order: 10,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /\((?:low(?:\s+(?:effort|reasoning))?)\)\s*$/i,
    normalized: "Low",
    order: 20,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /\((?:medium(?:\s+(?:effort|reasoning))?)\)\s*$/i,
    normalized: "Medium",
    order: 30,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /\((?:high(?:\s+(?:effort|reasoning))?)\)\s*$/i,
    normalized: "High",
    order: 40,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /\((?:very\s+high(?:\s+(?:effort|reasoning))?)\)\s*$/i,
    normalized: "Very High",
    order: 50,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /\((?:xhigh|extra[- ]high|max(?:\s+effort)?)\)\s*$/i,
    normalized: "XHigh",
    order: 60,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /\((?:thinking|reasoning)\)\s*$/i,
    normalized: "Thinking",
    order: 35,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /\((?:adaptive(?:\s+reasoning)?)\)\s*$/i,
    normalized: "Adaptive",
    order: 45,
    ladderType: "special",
    isReasoning: true,
  },
];

const SLUG_EFFORT_MAP: Record<
  string,
  { normalized: string; order: number; ladderType: EffortLadderType; isReasoning: boolean }
> = {
  "non-thinking": { normalized: "Non-thinking", order: 0, ladderType: "standard", isReasoning: false },
  "non-reasoning": { normalized: "Non-thinking", order: 0, ladderType: "standard", isReasoning: false },
  none: { normalized: "Non-thinking", order: 0, ladderType: "standard", isReasoning: false },
  minimal: { normalized: "Minimal", order: 10, ladderType: "standard", isReasoning: true },
  low: { normalized: "Low", order: 20, ladderType: "standard", isReasoning: true },
  medium: { normalized: "Medium", order: 30, ladderType: "standard", isReasoning: true },
  high: { normalized: "High", order: 40, ladderType: "standard", isReasoning: true },
  "very-high": { normalized: "Very High", order: 50, ladderType: "standard", isReasoning: true },
  xhigh: { normalized: "XHigh", order: 60, ladderType: "standard", isReasoning: true },
  max: { normalized: "Max", order: 65, ladderType: "special", isReasoning: true },
  adaptive: { normalized: "Adaptive", order: 45, ladderType: "special", isReasoning: true },
  thinking: { normalized: "Thinking", order: 35, ladderType: "standard", isReasoning: true },
};

const BUDGET_REGEX = /\((\d+)\s*(?:k\s*)?tokens?\)\s*$/i;
const COMPOUND_PAREN_REGEX = /^(.+?)\s*\(([^()]+)\)\s*$/;

const COMPOUND_EFFORT_TOKENS: Array<{
  pattern: RegExp;
  kind: "non_reasoning" | "effort";
  normalized: string;
  order: number;
  ladderType: EffortLadderType;
  isReasoning: boolean;
}> = [
  {
    pattern: /^(?:non-?thinking|non-?reasoning|no[- ]?thinking|none)$/i,
    kind: "non_reasoning",
    normalized: "Non-thinking",
    order: 0,
    ladderType: "standard",
    isReasoning: false,
  },
  {
    pattern: /^minimal(?:\s+effort)?$/i,
    kind: "effort",
    normalized: "Minimal",
    order: 10,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /^low(?:\s+(?:effort|reasoning))?$/i,
    kind: "effort",
    normalized: "Low",
    order: 20,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /^medium(?:\s+(?:effort|reasoning))?$/i,
    kind: "effort",
    normalized: "Medium",
    order: 30,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /^high(?:\s+(?:effort|reasoning))?$/i,
    kind: "effort",
    normalized: "High",
    order: 40,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /^very\s+high(?:\s+(?:effort|reasoning))?$/i,
    kind: "effort",
    normalized: "Very High",
    order: 50,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /^(?:xhigh|extra[- ]high)$/i,
    kind: "effort",
    normalized: "XHigh",
    order: 60,
    ladderType: "standard",
    isReasoning: true,
  },
  {
    pattern: /^max(?:\s+effort)?$/i,
    kind: "effort",
    normalized: "Max",
    order: 65,
    ladderType: "special",
    isReasoning: true,
  },
  {
    pattern: /^adaptive(?:\s+reasoning)?$/i,
    kind: "effort",
    normalized: "Adaptive",
    order: 45,
    ladderType: "special",
    isReasoning: true,
  },
  {
    pattern: /^(?:thinking|reasoning)$/i,
    kind: "effort",
    normalized: "Thinking",
    order: 35,
    ladderType: "standard",
    isReasoning: true,
  },
];

function parseCompoundParenthetical(trimmedName: string): {
  effortRaw: string;
  effortNormalized: string;
  effortOrder: number;
  effortLadderType: EffortLadderType;
  isReasoningModel: boolean;
  baseName: string;
} | null {
  const match = COMPOUND_PAREN_REGEX.exec(trimmedName);
  if (!match) return null;

  const prefix = match[1].trim();
  const parenContent = match[2].trim();
  if (!parenContent.includes(",")) return null;

  const tokens = parenContent
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length < 2) return null;

  let hasNonReasoning = false;
  let primaryEffort: (typeof COMPOUND_EFFORT_TOKENS)[number] | null = null;
  const remaining: string[] = [];

  for (const token of tokens) {
    const matched = COMPOUND_EFFORT_TOKENS.find((t) => t.pattern.test(token));
    if (matched) {
      if (matched.kind === "non_reasoning") {
        hasNonReasoning = true;
      } else if (!primaryEffort) {
        primaryEffort = matched;
      }
      continue;
    }
    if (/fallback$/i.test(token)) {
      continue;
    }
    remaining.push(token);
  }

  if (!hasNonReasoning && !primaryEffort) {
    return null;
  }

  const baseName =
    remaining.length > 0 ? `${prefix} (${remaining.join(", ")})` : prefix;

  if (hasNonReasoning) {
    if (primaryEffort) {
      const subOrder =
        primaryEffort.normalized === "High"
          ? 2
          : primaryEffort.normalized === "Low"
            ? -2
            : 1;
      return {
        effortRaw: parenContent,
        effortNormalized: `Non-thinking (${primaryEffort.normalized})`,
        effortOrder: subOrder,
        effortLadderType: "standard",
        isReasoningModel: false,
        baseName,
      };
    }
    return {
      effortRaw: parenContent,
      effortNormalized: "Non-thinking",
      effortOrder: 0,
      effortLadderType: "standard",
      isReasoningModel: false,
      baseName,
    };
  }

  return {
    effortRaw: parenContent,
    effortNormalized: primaryEffort!.normalized,
    effortOrder: primaryEffort!.order,
    effortLadderType: primaryEffort!.ladderType,
    isReasoningModel: primaryEffort!.isReasoning,
    baseName,
  };
}

interface OverrideEntry {
  baseName?: string;
  effortNormalized?: string;
  effortOrder?: number;
  effortLadderType?: EffortLadderType;
  isReasoningModel?: boolean;
}

export function parseEffortAndRelease(params: {
  rawName: string;
  slug: string;
  structuredEffort?: string | null;
}): EffortParseResult {
  const { rawName, slug, structuredEffort } = params;
  const trimmedName = rawName.trim();

  // Priority 1: Structured upstream field
  if (structuredEffort && structuredEffort.trim().length > 0) {
    const key = structuredEffort.trim().toLowerCase().replace(/\s+/g, "-");
    const mapped = SLUG_EFFORT_MAP[key];
    const baseName = stripEffortFromModelName(trimmedName);
    if (mapped) {
      return {
        effortRaw: structuredEffort.trim(),
        effortNormalized: mapped.normalized,
        effortOrder: mapped.order,
        effortLadderType: mapped.ladderType,
        isReasoningModel: mapped.isReasoning,
        isGrouped: true,
        baseName,
      };
    }
    const tokenMatch = /^(\d+)\s*(k)?\s*tokens?$/i.exec(structuredEffort.trim());
    if (tokenMatch) {
      const num = parseInt(tokenMatch[1], 10) * (tokenMatch[2] ? 1000 : 1);
      return {
        effortRaw: structuredEffort.trim(),
        effortNormalized: `${num} Tokens`,
        effortOrder: num,
        effortLadderType: "budget",
        isReasoningModel: num > 0,
        isGrouped: true,
        baseName,
      };
    }
  }

  // Priority 2a: Explicit parenthetical effort marker in model name
  for (const rule of STANDARD_EFFORT_RULES) {
    const match = rule.pattern.exec(trimmedName);
    if (match) {
      const effortRaw = match[0].replace(/^\(|\)$/g, "").trim();
      const baseName = trimmedName.slice(0, match.index).trim();
      const normalized =
        effortRaw.toLowerCase() === "max" || effortRaw.toLowerCase() === "max effort"
          ? "Max"
          : rule.normalized;
      const order = normalized === "Max" ? 65 : rule.order;
      const ladderType = normalized === "Max" ? "special" : rule.ladderType;
      return {
        effortRaw,
        effortNormalized: normalized,
        effortOrder: order,
        effortLadderType: ladderType,
        isReasoningModel: rule.isReasoning,
        isGrouped: true,
        baseName,
      };
    }
  }

  // Priority 2b: Token budget marker in model name, e.g. "(4096 Tokens)" or "(32k tokens)"
  const budgetMatch = BUDGET_REGEX.exec(trimmedName);
  if (budgetMatch) {
    const rawNum = parseInt(budgetMatch[1], 10);
    const hasK = /k\s*tokens?/i.test(budgetMatch[0]);
    const tokens = hasK ? rawNum * 1000 : rawNum;
    const effortRaw = budgetMatch[0].replace(/^\(|\)$/g, "").trim();
    const baseName = trimmedName.slice(0, budgetMatch.index).trim();
    return {
      effortRaw,
      effortNormalized: `${tokens} Tokens`,
      effortOrder: tokens,
      effortLadderType: "budget",
      isReasoningModel: tokens > 0,
      isGrouped: true,
      baseName,
    };
  }

  // Priority 2b-compound: Comma-separated compound parentheticals, e.g. "(High, Default Fallback)" or "(Non-reasoning, High)"
  const compound = parseCompoundParenthetical(trimmedName);
  if (compound) {
    return {
      effortRaw: compound.effortRaw,
      effortNormalized: compound.effortNormalized,
      effortOrder: compound.effortOrder,
      effortLadderType: compound.effortLadderType,
      isReasoningModel: compound.isReasoningModel,
      isGrouped: true,
      baseName: compound.baseName,
    };
  }

  // Priority 2c: Explicit suffix in slug (e.g. "model-name-high" or "model-name-non-thinking")
  const normalizedSlug = slug.trim().toLowerCase();
  for (const [suffix, info] of Object.entries(SLUG_EFFORT_MAP)) {
    if (normalizedSlug.endsWith(`-${suffix}`)) {
      return {
        effortRaw: suffix,
        effortNormalized: info.normalized,
        effortOrder: info.order,
        effortLadderType: info.ladderType,
        isReasoningModel: info.isReasoning,
        isGrouped: true,
        baseName: stripEffortFromModelName(trimmedName),
      };
    }
  }

  // Priority 3: Manual mapping configuration
  const overrides = (modelMappings.overrides ?? {}) as Record<string, OverrideEntry>;
  const override = overrides[slug] ?? overrides[trimmedName];
  if (override) {
    return {
      effortRaw: override.effortNormalized ?? null,
      effortNormalized: override.effortNormalized ?? null,
      effortOrder: override.effortOrder ?? null,
      effortLadderType: override.effortLadderType ?? "single",
      isReasoningModel: override.isReasoningModel ?? null,
      isGrouped: Boolean(override.baseName),
      baseName: override.baseName ?? trimmedName,
    };
  }

  // Fallback: ungrouped standalone point (do NOT guess or merge)
  return {
    effortRaw: null,
    effortNormalized: null,
    effortOrder: null,
    effortLadderType: "single",
    isReasoningModel: null,
    isGrouped: false,
    baseName: trimmedName,
  };
}

export function stripEffortFromModelName(name: string): string {
  let result = name.trim();
  const compound = parseCompoundParenthetical(result);
  if (compound) {
    return compound.baseName;
  }
  for (const rule of STANDARD_EFFORT_RULES) {
    result = result.replace(rule.pattern, "").trim();
  }
  result = result.replace(BUDGET_REGEX, "").trim();
  return result;
}

export function extractModelFamily(baseName: string): string {
  const cleaned = baseName
    .replace(/\s+\d{4}-\d{2}-\d{2}$/, "")
    .replace(/\s+\(\d{4}\)$/, "")
    .trim();
  const tokens = cleaned.split(/\s+/);
  if (tokens.length <= 2) return cleaned;
  return tokens.slice(0, 2).join(" ");
}

/**
 * Standard ladder steps are spaced by 10 (10=Minimal, 20=Low, 30=Medium, 40=High, 50=Very High, 60=XHigh).
 * If two adjacent measured points on a standard ladder have a gap > 15 (e.g. Low=20 to High=40 skipping Medium=30),
 * or Non-thinking=0 to Medium=30, we draw a dashed segment to indicate unmeasured intermediate tiers.
 */
export function hasEffortGap(
  prevOrder: number | null,
  nextOrder: number | null,
  ladderType: EffortLadderType
): boolean {
  if (prevOrder === null || nextOrder === null) return false;
  if (ladderType === "standard") {
    return Math.abs(nextOrder - prevOrder) > 15;
  }
  return false;
}
