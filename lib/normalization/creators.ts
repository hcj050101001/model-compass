import providersConfig from "@/config/providers.json";

export interface ResolvedCreator {
  id: string;
  name: string;
  slug: string;
  country: string | null;
  website: string | null;
  color: string;
}

interface ProviderConfigEntry {
  name: string;
  slug: string;
  country: string | null;
  website: string | null;
  color: string;
}

const KNOWN_CREATORS = providersConfig.creators as Record<string, ProviderConfigEntry>;
const FALLBACK_PALETTE = providersConfig.fallbackPalette as string[];

function hashSlug(slug: string): number {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function normalizeCreatorSlug(rawSlugOrName: string): string {
  return rawSlugOrName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolveCreator(input: {
  id?: string | null;
  name?: string | null;
  slug?: string | null;
}): ResolvedCreator {
  const rawSlug = input.slug ?? input.name ?? input.id ?? "unknown";
  const slugKey = normalizeCreatorSlug(rawSlug);

  // Check exact match or alias prefix
  const exact = KNOWN_CREATORS[slugKey];
  if (exact) {
    return {
      id: `creator_${exact.slug}`,
      name: exact.name,
      slug: exact.slug,
      country: exact.country,
      website: exact.website,
      color: exact.color,
    };
  }

  // Partial alias matching for known creators (e.g. "alibaba-cloud", "zhipu-ai", "moonshot-ai")
  for (const [key, entry] of Object.entries(KNOWN_CREATORS)) {
    if (slugKey === key || slugKey.startsWith(`${key}-`) || slugKey.includes(key)) {
      return {
        id: `creator_${entry.slug}`,
        name: entry.name,
        slug: entry.slug,
        country: entry.country,
        website: entry.website,
        color: entry.color,
      };
    }
  }

  const displayName = input.name?.trim() || rawSlug || "Unknown";
  const color = FALLBACK_PALETTE[hashSlug(slugKey) % FALLBACK_PALETTE.length];
  return {
    id: `creator_${slugKey || "unknown"}`,
    name: displayName,
    slug: slugKey || "unknown",
    country: null,
    website: null,
    color,
  };
}
