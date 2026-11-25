/**
 * Homepage (mainstream provider) candidate scope, shared between the
 * dashboard UI and the server-side coverage gate so both count the same
 * candidate set (Package E prep: one server-usable definition, no copied
 * client logic).
 */
export const MAINSTREAM_PROVIDER_ORDER = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "deepseek",
  "alibaba",
  "zhipu",
  "moonshot",
  "minimax",
  "bytedance-seed",
  "meta",
  "tencent",
  "baidu",
  "xiaomi",
  "stepfun",
] as const;

export const MAINSTREAM_PROVIDER_SET: ReadonlySet<string> = new Set(
  MAINSTREAM_PROVIDER_ORDER
);
