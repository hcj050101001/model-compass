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
- **Grade C**: Standardized Estimated Agent Cost (**EAC**) computed from the `mt-v2` multi-turn developer agent simulation (`lib/agent-cost/developer-cost.ts`) across three task profiles (`light`: 6 turns, 10K→30K, ~20K avg; `standard`: 11 turns, 24K→104K, ~64K avg; `heavy`: 17 turns, 48K→272K, ~160K avg) and official token/cache pricing.
  - **(1) Multi-Turn Agent Session Cost (`mt-v2`)**:
    $$\mathcal{C} = \frac{U p_{\text{in}} + R p_{\text{r}} + W p_{\text{w}} + (O_{\text{v}} + O_{\text{t}}) p_{\text{out}}}{10^6}$$
    - `e.g.` (`standard`, 11 turns, `High` effort, `128K` window, `$1/$4`): $U,\, p_{\text{in}}$ (`60K × $1.00/M = $0.06`), $R,\, p_{\text{r}}$ (`540K × $0.20/M = $0.11`), $W,\, p_{\text{w}}$ (`140K × $1.25/M = $0.17`, 0 if auto-cache), $O_{\text{v}},\, O_{\text{t}},\, p_{\text{out}}$ (`(11.9K + 52.8K) × $4.00/M = $0.26`) $\Rightarrow$ $\mathcal{C} \approx \$0.60$ (`~$1.00` uncached; `$0.55` on a 1M window without compaction).
  - **(2) Context-Weighted Effective Load**:
    $$C_{\text{eff}} = \bar{c} + 4\bar{o}$$
    Dual strictly less-than thresholds: Light `< 36K` $\bar{c}$ & `< 44K` $C_{\text{eff}}$; Standard `< 110K` $\bar{c}$ & `< 120K` $C_{\text{eff}}$; otherwise Heavy (`e.g.` `64K + 4×0.9K = 67.6K`, Standard).
  - **Prompt Caching, Compaction & Thinking (`prefixHitRate = 0.9`)**: Supported discounted cache reads apply $h = 0.90$, aligned with observed **80%–92%** production coding agent cache hit rates (`e.g.` Claude Code ~92%, Cursor 84%–99%) and **85%–95%** read discounts, distinguishing explicit cache writes (e.g. Anthropic 1.25× input fallback) from automatic zero-surcharge prefix caching. Exceeding $\lfloor 0.8W \rfloor$ triggers compaction ($\mathrm{round}(0.35 \lfloor 0.8W \rfloor)$ + 2,000 summary tokens) and cache rewrite; reasoning effort adds per-turn thinking tokens (`0 / 300 / 900 / 2,200 / 4,800 / 8,000 / 12,000` or `N Tokens`) billed at $p_{\text{out}}$.
- **`estimated_cost` field**: In API responses and the standardized export, `estimated_cost` is the `mt-v2` multi-turn simulation result for the `standard` task profile (not a measured cost). The legacy `legacy-v1` single-pass entry point (`lib/agent-cost/eac.ts`, `config/agent-cost-config.json`) remains available only as the frontier API's `custom_agent` mode. OpenRouter enrichment (above) may backfill a missing `context_window` and any of the four token/cache prices, but never overwrites Artificial Analysis or LiteLLM values already present.
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
