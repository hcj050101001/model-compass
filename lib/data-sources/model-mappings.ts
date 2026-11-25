import fs from "node:fs";
import path from "node:path";
import type { FieldProvenance } from "@/lib/agent-cost/types";

/**
 * Cross-channel pricing mappings (Package C, design sec.2.4).
 *
 * A price from another channel (LiteLLM / OpenRouter) may only fill a field
 * when a maintainer-verified entry in config/model-mappings.json binds the
 * exact release (creator slug + release name + release date when known) to
 * the exact upstream catalog key. Name similarity, candidate order, or
 * "direct provider" heuristics are NOT evidence of identity and are never
 * used for matching.
 */
export interface VerifiedChannelMapping {
  channel: "litellm" | "openrouter";
  creatorSlug: string;
  releaseName: string;
  releaseDate?: string | null;
  upstreamKey: string;
  verifiedBy: string;
  verifiedAt?: string | null;
}

interface ModelMappingsFile {
  overrides?: Record<string, unknown>;
  channelMappings?: unknown;
}

let cached: VerifiedChannelMapping[] | null = null;

export function loadVerifiedChannelMappings(
  filePath?: string
): VerifiedChannelMapping[] {
  if (!filePath && cached) return cached;
  const resolved =
    filePath ?? path.resolve(process.cwd(), "config", "model-mappings.json");
  let parsed: ModelMappingsFile = {};
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as ModelMappingsFile;
  } catch {
    parsed = {};
  }
  const raw = Array.isArray(parsed.channelMappings)
    ? parsed.channelMappings
    : [];
  const out: VerifiedChannelMapping[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.channel !== "litellm" && e.channel !== "openrouter") continue;
    if (typeof e.creatorSlug !== "string" || !e.creatorSlug) continue;
    if (typeof e.releaseName !== "string" || !e.releaseName) continue;
    if (typeof e.upstreamKey !== "string" || !e.upstreamKey) continue;
    // Maintainer verification marker is mandatory; unsigned entries are
    // ignored (no self-signed mapping data is ever trusted).
    if (typeof e.verifiedBy !== "string" || !e.verifiedBy.trim()) continue;
    out.push({
      channel: e.channel,
      creatorSlug: e.creatorSlug,
      releaseName: e.releaseName,
      releaseDate:
        typeof e.releaseDate === "string" ? e.releaseDate : null,
      upstreamKey: e.upstreamKey,
      verifiedBy: e.verifiedBy,
      verifiedAt: typeof e.verifiedAt === "string" ? e.verifiedAt : null,
    });
  }
  if (!filePath) cached = out;
  return out;
}

export function normalizeReleaseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Returns the single verified mapping for a release on a channel, or null
 * when there is none — or when several distinct upstream keys claim the same
 * release (ambiguous ownership: fill nothing).
 */
export function findVerifiedMapping(params: {
  channel: "litellm" | "openrouter";
  creatorSlug: string;
  releaseName: string;
  releaseDate?: string | null;
  mappings?: VerifiedChannelMapping[];
}): VerifiedChannelMapping | null {
  const mappings = params.mappings ?? loadVerifiedChannelMappings();
  const matches = mappings.filter(
    (m) =>
      m.channel === params.channel &&
      m.creatorSlug === params.creatorSlug &&
      normalizeReleaseName(m.releaseName) ===
        normalizeReleaseName(params.releaseName) &&
      (m.releaseDate == null ||
        params.releaseDate == null ||
        m.releaseDate === params.releaseDate)
  );
  const keys = new Set(matches.map((m) => m.upstreamKey));
  if (matches.length === 0 || keys.size !== 1) return null;
  return matches[0];
}

/** Strict price validation: finite, non-negative, and never coerced to 0. */
export function isValidPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Converts a per-token price to per-million. Returns null for anything that
 * is not a finite non-negative number, for overflow, and for a non-zero
 * input that would round down to zero.
 */
export function perTokenToPerMillion(perToken: unknown): number | null {
  if (!isValidPrice(perToken)) return null;
  const converted = Number((perToken * 1_000_000).toFixed(6));
  if (!Number.isFinite(converted)) return null;
  if (perToken > 0 && converted <= 0) return null;
  return converted;
}

/**
 * Parses an OpenRouter decimal-string price strictly: only plain decimal or
 * scientific-notation strings are accepted (no blank strings, no suffixes,
 * no loose Number() coercions).
 */
export function parseStrictDecimalPrice(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return null;
  const perToken = Number(trimmed);
  return perTokenToPerMillion(perToken);
}

export function makeProvenance(params: {
  source: string;
  upstreamKey: string | null;
  currency?: string | null;
  unit?: string | null;
  observedAt?: string | null;
  firstObservedAt?: string | null;
}): FieldProvenance {
  return {
    source: params.source,
    upstreamKey: params.upstreamKey,
    currency: params.currency === undefined ? "USD" : params.currency,
    unit: params.unit === undefined ? "USD_per_million_tokens" : params.unit,
    observedAt: params.observedAt ?? null,
    firstObservedAt: params.firstObservedAt ?? null,
  };
}

export function unknownProvenance(): FieldProvenance {
  return {
    source: "unknown",
    upstreamKey: null,
    currency: null,
    unit: null,
    observedAt: null,
    firstObservedAt: null,
  };
}
