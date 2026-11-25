import { describe, expect, it } from "vitest";
import { fetchAllAAModels, AAApiError } from "@/lib/data-sources/artificial-analysis/client";

function makeJsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("Artificial Analysis Sync Client", () => {
  it("fetches multiple pages and captures rate-limit headers", async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes("page=1")) {
        return makeJsonResponse(
          {
            tier: "free",
            intelligence_index_version: 5,
            pagination: { page: 1, total_pages: 2, has_more: true },
            data: [{ id: "1", name: "Model A", slug: "model-a" }],
          },
          200,
          { "X-RateLimit-Remaining": "98" }
        );
      }
      return makeJsonResponse(
        {
          tier: "free",
          intelligence_index_version: 5,
          pagination: { page: 2, total_pages: 2, has_more: false },
          data: [{ id: "2", name: "Model B", slug: "model-b" }],
        },
        200,
        { "X-RateLimit-Remaining": "97" }
      );
    };

    const res = await fetchAllAAModels({
      apiKey: "test-key",
      tier: "free",
      fetchImpl: mockFetch,
    });
    expect(calls).toBe(2);
    expect(res.items).toHaveLength(2);
    expect(res.indexVersion).toBe("5");
    expect(res.rateLimitRemaining).toBe(97);
  });

  it("fails immediately on HTTP 401 without retrying", async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async () => {
      calls += 1;
      return makeJsonResponse({ error: "Unauthorized" }, 401);
    };

    await expect(
      fetchAllAAModels({
        apiKey: "bad-key",
        tier: "free",
        maxRetries: 3,
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(AAApiError);
    expect(calls).toBe(1);
  });

  it("aborts if intelligence_index_version changes mid-pagination", async () => {
    const mockFetch: typeof fetch = async (input) => {
      if (String(input).includes("page=1")) {
        return makeJsonResponse({
          intelligence_index_version: 5,
          pagination: { page: 1, has_more: true },
          data: [{ id: "1", name: "Model A", slug: "model-a" }],
        });
      }
      return makeJsonResponse({
        intelligence_index_version: 6,
        pagination: { page: 2, has_more: false },
        data: [{ id: "2", name: "Model B", slug: "model-b" }],
      });
    };

    await expect(
      fetchAllAAModels({
        apiKey: "test-key",
        tier: "free",
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/version changed mid-pagination/);
  });

  it("rejects schema drift cleanly", async () => {
    const mockFetch: typeof fetch = async () =>
      makeJsonResponse({ unexpected: "shape" }, 200);

    await expect(
      fetchAllAAModels({
        apiKey: "test-key",
        tier: "free",
        maxRetries: 0,
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/schema validation failed/);
  });
});
