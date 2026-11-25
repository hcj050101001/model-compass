import {
  AALanguageModelsResponseSchema,
  type AAModelItem,
} from "./schema";

export interface AAClientConfig {
  apiKey: string;
  tier: "free" | "pro" | "commercial";
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface AAFetchResult {
  items: AAModelItem[];
  indexVersion: string;
  tier: string;
  pagesFetched: number;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitReset: string | null;
}

export class AAApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AAApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOptionalInt(val: string | null): number | null {
  if (!val) return null;
  const parsed = Number.parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function fetchAllAAModels(
  config: AAClientConfig
): Promise<AAFetchResult> {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new AAApiError("Missing AA_API_KEY", 401);
  }

  const baseUrl = (
    config.baseUrl ?? "https://artificialanalysis.ai/api/v2"
  ).replace(/\/+$/, "");
  const endpoint =
    config.tier === "free"
      ? `${baseUrl}/language/models/free`
      : `${baseUrl}/language/models`;
  const timeoutMs = config.timeoutMs ?? 20_000;
  const maxRetries = config.maxRetries ?? 3;
  const fetchFn = config.fetchImpl ?? fetch;

  const allItems: AAModelItem[] = [];
  let page = 1;
  let hasMore = true;
  let lockedIndexVersion: string | null = null;
  let detectedTier: string = config.tier;
  let rateLimitLimit: number | null = null;
  let rateLimitRemaining: number | null = null;
  let rateLimitReset: string | null = null;

  while (hasMore) {
    const url = `${endpoint}?page=${page}`;
    let lastError: Error | null = null;
    let pagePayload: ReturnType<typeof AALanguageModelsResponseSchema.parse> | null =
      null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetchFn(url, {
          method: "GET",
          headers: {
            "x-api-key": config.apiKey,
            Accept: "application/json",
          },
          signal: controller.signal,
        });
        clearTimeout(timer);

        rateLimitLimit =
          parseOptionalInt(res.headers.get("X-RateLimit-Limit")) ?? rateLimitLimit;
        rateLimitRemaining =
          parseOptionalInt(res.headers.get("X-RateLimit-Remaining")) ??
          rateLimitRemaining;
        rateLimitReset =
          res.headers.get("X-RateLimit-Reset") ?? rateLimitReset;

        if (res.status === 401 || res.status === 403) {
          throw new AAApiError(
            `Artificial Analysis API authentication/authorization failed (HTTP ${res.status})`,
            res.status
          );
        }

        if (res.status === 429) {
          const retryAfter = parseOptionalInt(res.headers.get("Retry-After")) ?? 2;
          if (attempt < maxRetries) {
            await sleep(Math.min(retryAfter * 1000, 10_000) * (attempt + 1));
            continue;
          }
          throw new AAApiError(
            `Artificial Analysis API rate limit exceeded (HTTP 429)`,
            429,
            retryAfter
          );
        }

        if (res.status >= 500) {
          if (attempt < maxRetries) {
            await sleep(500 * Math.pow(2, attempt));
            continue;
          }
          throw new AAApiError(
            `Artificial Analysis API server error (HTTP ${res.status})`,
            res.status
          );
        }

        if (!res.ok) {
          throw new AAApiError(
            `Unexpected HTTP status ${res.status} from Artificial Analysis API`,
            res.status
          );
        }

        const json = await res.json();
        const parsed = AALanguageModelsResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw new AAApiError(
            `Artificial Analysis API schema validation failed on page ${page}: ${parsed.error.issues[0]?.message ?? "invalid payload"}`
          );
        }

        pagePayload = parsed.data;
        break;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof AAApiError && (err.statusCode === 401 || err.statusCode === 403)) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          await sleep(400 * Math.pow(2, attempt));
        }
      }
    }

    if (!pagePayload) {
      throw lastError ?? new AAApiError(`Failed to fetch page ${page}`);
    }

    if (pagePayload.tier) {
      detectedTier = pagePayload.tier;
    }

    const pageVersion =
      pagePayload.intelligence_index_version !== null &&
      pagePayload.intelligence_index_version !== undefined
        ? String(pagePayload.intelligence_index_version)
        : "unknown";

    if (lockedIndexVersion === null) {
      lockedIndexVersion = pageVersion;
    } else if (lockedIndexVersion !== pageVersion) {
      throw new AAApiError(
        `Intelligence Index version changed mid-pagination (${lockedIndexVersion} -> ${pageVersion}); aborting to preserve snapshot consistency.`
      );
    }

    allItems.push(...pagePayload.data);

    const pagination = pagePayload.pagination;
    if (pagination) {
      if (typeof pagination.has_more === "boolean") {
        hasMore = pagination.has_more;
      } else if (typeof pagination.total_pages === "number") {
        hasMore = page < pagination.total_pages;
      } else {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }

    page += 1;
    if (page > 100) {
      throw new AAApiError("Pagination safety limit exceeded (>100 pages)");
    }
  }

  return {
    items: allItems,
    indexVersion: lockedIndexVersion ?? "unknown",
    tier: detectedTier,
    pagesFetched: page - 1,
    rateLimitLimit,
    rateLimitRemaining,
    rateLimitReset,
  };
}
