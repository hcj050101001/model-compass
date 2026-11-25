# Data Sources & Methodology

## 1. Primary Intelligence Index: Artificial Analysis
- **Endpoints**:
  - Free Tier: `GET https://artificialanalysis.ai/api/v2/language/models/free` (`100 requests / 24h`)
  - Paid/Pro Tier: `GET https://artificialanalysis.ai/api/v2/language/models`
- **Version Isolation**: Every snapshot records `intelligence_index_version`. Cross-version comparisons and Pareto calculations across different index versions are rejected.
- **Cost Policy**: Artificial Analysis `cost_per_task` is **no longer used** because benchmark evaluation length does not represent real-world multi-turn Agent session economics.
- **Null Preservation**: Missing scores or prices remain `null` in SQLite (`benchmark_measurements`) and are never coerced to `0`.

## 2. Official Token & Cache Pricing Enrichment
- **Artificial Analysis Pricing**: `price_1m_input_tokens`, `price_1m_output_tokens`, `price_1m_cache_read_tokens`, `price_1m_cache_write_tokens`.
- **LiteLLM Official Pricing Catalog**: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` (deterministic backfill for missing input/output/cache-read/cache-write pricing, preferring direct provider entries).
- **OpenRouter Models API**: `GET https://openrouter.ai/api/v1/models` (backfills missing `context_window` and remaining missing token/cache pricing without overwriting official prices).

## 3. Real-world Agent Session Cost (RASC) & Data Quality Grades
- **Grade A**: Real Agent session records with actual billed USD amounts (`actualBilledUsd`).
- **Grade B**: Real Agent session token logs (e.g., authorized OpenTelemetry/Langfuse exports or anonymized user uploads) priced via official token & cache rates.
- **Grade C**: Standardized Estimated Agent Cost (**EAC**) computed from transparent, configurable session token templates (`light`, `standard`, `heavy`, or custom) and official pricing.
- **`estimated_cost` field**: In API responses and the standardized export, `estimated_cost` is the multi-turn simulation result for the `standard` task profile (not a measured cost). The legacy EAC entry point remains available as the frontier API's `custom_agent` mode. OpenRouter enrichment (above) may backfill a missing `context_window` and any of the four token/cache prices, but never overwrites Artificial Analysis or LiteLLM values already present.
- **Grade D**: Missing valid pricing and real session data; excluded from cost rankings.
- **Strict Isolation**: Grade A/B real costs and Grade C estimated costs are never mixed in the same Pareto frontier calculation.

## 4. Reasoning Effort Normalization
- Parsed in priority order:
  1. Upstream structured `reasoning_effort` / `effort` field.
  2. Explicit parenthetical or slug effort markers (`Non-thinking`, `Minimal`, `Low`, `Medium`, `High`, `Very High`, `XHigh`, `Max`, `Adaptive`, or token budgets like `4096 Tokens`).
  3. Manual overrides in `config/model-mappings.json`.
  4. Unmatched models remain standalone points (`isGrouped = false`).

## 5. Synthetic Demo Mode
- When `DEMO_MODE=true`, `scripts/seed-demo.ts` populates a synthetic dataset tagged `source = "demo-synthetic"` and `isDemo = true`. A global warning banner is always displayed in the UI.
