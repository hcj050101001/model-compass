# ModelCompass (智价罗盘) — AI Model Intelligence & Cost Analytics

**ModelCompass (智价罗盘)** is a bilingual, mobile-friendly analytics platform for comparing AI models and their **reasoning effort tiers** on a unified Cost-vs-Intelligence coordinate plane across coding, scientific research, analysis, and general agent tasks.

## Key Capabilities

- **Reasoning Effort Curves**: Each `ModelRelease` renders an independent curve connecting its measured reasoning effort tiers (e.g., `Non-thinking → Minimal → Low → Medium → High → Very High → XHigh`). Unmeasured intermediate tiers are drawn as dashed segments; distinct models/versions are never connected.
- **Unified Scales & Modes**:
  - Default X-axis: Official Artificial Analysis `cost_per_task.total_cost` (USD / Task) on Log or Linear scale.
  - Switchable X-axis modes: Input Price, Output Price, Cache Read Price, Blended Price (customizable Input/Output ratio, default 75/25), and Custom Workload Estimator (explicitly marked as estimated).
  - Switchable Y-axis metrics: AA Intelligence Index, AA Coding Index, AA Agentic Index, strictly isolated by `intelligence_index_version`.
  - Zero-cost valid models are surfaced in a dedicated strip when Log scale is active rather than faking small positive numbers.
- **Pareto Frontier & Superior Alternatives**:
  - Strict Pareto dominance calculation (`calculateParetoFrontier`, `isDominated`, `findDominators`) with global vs. local frontier overlays.
  - Approximate superior alternative discovery with configurable cost tolerance (%) and minimum score gain, clearly separated from strict mathematical dominance.
- **Target & Marginal Analyzers**:
  - Mode A: Best model within fixed budget.
  - Mode B: Cheapest model meeting minimum intelligence.
  - Mode C: Side-by-side multi-model comparison (`/compare`).
  - Mode D: Pareto-based Agent Routing candidate tiers.
  - Per-model marginal effort return analysis (`ΔScore / ΔCost`).
- **Resilient Data Pipeline**:
  - Artificial Analysis API v2 adapter (`/api/v2/language/models/free` & `/api/v2/language/models`) with pagination, `X-RateLimit-*` tracking, exponential backoff, mid-pagination version-drift protection, and atomic SQLite snapshot switching.
  - Optional OpenRouter metadata enrichment (`context_window`) without mixing third-party scores or replacing official task costs.

## Quick Start (Local Development)

```bash
npm install
cp .env.example .env
# Edit .env and set ACCESS_PASSWORD, ADMIN_TOKEN, SESSION_SECRET (and AA_API_KEY when ready)
npm run db:migrate
npm run seed:demo
npm run dev
```

Open `http://127.0.0.1:3100`.

## Obtaining & Configuring a Live Artificial Analysis API Key

1. Sign in at [https://artificialanalysis.ai/data-api](https://artificialanalysis.ai/data-api) and generate a free-tier API key (`100 requests / 24h`).
2. Update `.env`:
   ```env
   AA_API_KEY=your_real_api_key_here
   AA_API_TIER=free
   DEMO_MODE=false
   ```
3. Run `npm run sync:data` (or click **Sync** in the UI) and restart the server.

## Testing & Verification

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```

## Attribution & License Compliance

Intelligence scores and official cost-per-task data are sourced from [Artificial Analysis](https://artificialanalysis.ai/). Free-tier API data is intended for personal/internal analysis and must display visible attribution to Artificial Analysis; public redistribution of the full dataset is restricted without explicit permission. Private Mode (`PRIVATE_MODE=true`) is enabled by default.
