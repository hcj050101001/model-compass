import {
  OpenRouterModelsResponseSchema,
  type OpenRouterModel,
} from "./schema";

export async function fetchOpenRouterModels(params?: {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<OpenRouterModel[]> {
  const baseUrl = (params?.baseUrl ?? "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    ""
  );
  const fetchFn = params?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params?.timeoutMs ?? 12_000);

  try {
    const res = await fetchFn(`${baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}`);
    }
    const json = await res.json();
    const parsed = OpenRouterModelsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("OpenRouter schema validation failed");
    }
    return parsed.data.data;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
