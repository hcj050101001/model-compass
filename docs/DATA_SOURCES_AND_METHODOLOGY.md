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
  - **(1) Context-Weighted Effective Load**:
    $$C_{\text{eff}} = \overline{C} + 4 \cdot \overline{O}_{\text{turn}}, \qquad V_{\text{in}} = N \cdot \overline{C}$$
    Dual strictly less-than thresholds: Light `< 36K` avg & `< 44K` $C_{\text{eff}}$; Standard `< 110K` avg & `< 120K` $C_{\text{eff}}$; otherwise Heavy (`e.g.` Standard: $\overline{C}=64\text{K},\,\overline{O}_{\text{turn}}=900 \Rightarrow C_{\text{eff}}=67.6\text{K},\,V_{\text{in}}=704\text{K}$).
  - **(2) Multi-Turn Cache & Compaction Recurrence (`prefixHitRate = 0.9`)**:
    $$C_{\text{read},t} = \mathrm{round}(h \cdot C_{t-1}), \qquad U_{\text{in},t} = (C_{t-1} - C_{\text{read},t}) + \mathbb{I}_{\text{auto}} \Delta_t, \qquad C_{\text{write},t} = \mathbb{I}_{\text{explicit}} \Delta_t$$
    Supported discounted cache reads apply $h = 0.90$, aligned with observed **80%–92%** production coding agent cache hit rates (`e.g.` Claude Code ~92% / 90% alert floor, Cursor 84%–99% cache-read share, OpenCode ~89%, Aider ~84%, Zed ~80%) and typical **85%–95%** provider read discounts. Distinguishes explicit cache writes (`e.g.` Anthropic 1.25× input fallback) from automatic zero-surcharge prefix caching (OpenAI / DeepSeek / Google). Exceeding $W_{\text{use}} = \lfloor 0.8W \rfloor$ triggers compaction to $\mathrm{round}(0.35 W_{\text{use}})$ + 2,000 summary output tokens and invalidates/rewrites the prefix cache; reasoning effort adds per-turn thinking tokens (`0 / 300 / 900 / 2,200 / 4,800 / 8,000 / 12,000` or explicit `N Tokens`) billed at $P_{\text{out}}$.
  - **(3) Four-Part Session Cost Formula (`mt-v2`)**:
    $$\text{TotalCost} = \frac{U_{\text{in}} \cdot P_{\text{in}} + C_{\text{read}} \cdot P_{\text{cache\_read}} + C_{\text{write}} \cdot P_{\text{cache\_write}} + (O_{\text{vis}} + O_{\text{think}}) \cdot P_{\text{out}}}{10^6}$$
    - `e.g.` **Worked Example** (`standard`, 11 turns, `High` effort, `128K` window, `$1/1M` input, `$4/1M` output):
      - Uncached input $U_{\text{in}} = 60{,}000 \times \$1.00/10^6 = \$0.0600$
      - Cache read $C_{\text{read}} = 540{,}000 \times \$0.20/10^6 = \$0.1080$
      - Explicit cache write $C_{\text{write}} = 139{,}840 \times \$1.25/10^6 = \$0.1748$ (including 1 compaction rewrite at turn 11)
      - Output + thinking $(O_{\text{vis}} + O_{\text{think}}) = (11{,}900 + 52{,}800) \times \$4.00/10^6 = \$0.2588$
      - **Total**: **`$0.6016`** (vs `$0.9986` uncached; vs `$0.5488` on a 1M window with 0 compactions, `+9.6%` compaction penalty).
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
