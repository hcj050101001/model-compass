# ModelCompass (智价罗盘) — AI Model Intelligence & Cost Analytics

**ModelCompass (智价罗盘)** is a bilingual, mobile-friendly analytics platform for comparing AI models and their **reasoning effort tiers** on a unified Cost-vs-Intelligence coordinate plane across coding, scientific research, analysis, and general agent tasks.

## Key Capabilities

- **Reasoning Effort Curves**: Each `ModelRelease` renders an independent curve connecting its measured reasoning effort tiers (e.g., `Non-thinking → Minimal → Low → Medium → High → Very High → XHigh`). Unmeasured intermediate tiers are drawn as dashed segments; distinct models/versions are never connected.
- **Unified Scales & Modes**:
  - Default X-axis: the multi-turn **estimated** task cost (EAC) computed from official token/cache pricing and the selected task profile (`light` / `standard` / `heavy`, default `standard`), on Log or Linear scale. The homepage chart is an intelligence-vs-estimate view; it is not the Artificial Analysis `cost_per_task` figure (which is not used, see `docs/DATA_SOURCES_AND_METHODOLOGY.md`).
  - Switchable X-axis modes: measured RASC (USD / effective task), measured P50 session cost (USD / session), the multi-turn estimate above (USD / simulated task), Input / Output / Cache Read unit prices (USD / 1M tokens), and the legacy `custom_agent` estimator entry point.
  - The `/api/frontier` endpoint takes the cost mode explicitly via `xMode` and defaults to measured `rasc` (unlike the homepage, whose default view is the estimate); the homepage settings copy and the API default are documented separately on purpose.
  - Switchable Y-axis metrics: AA Intelligence Index, AA Coding Index, AA Agentic Index, strictly isolated by `intelligence_index_version`.
  - Homepage chart/frontier candidates require a positive estimated cost; zero-cost entries are never faked into small positive numbers and remain available in the standard records and leaderboard. The `/compare` page performs pairwise comparison of selected variants under one cost scale.
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
  - Optional OpenRouter enrichment that backfills a missing `context_window` and any missing token/cache prices, without mixing third-party scores or overwriting Artificial Analysis or LiteLLM values already present.

## Quick Start (Local Development)

```bash
npm install
cp .env.example .env
# Generate ACCESS_PASSWORD and SESSION_SECRET independently as shown in .env.example.
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
3. Run `npm run sync:data` from the operator environment. The settings page shows sync status.

## Trusted Reverse Proxy

Set `TRUST_PROXY=true` when deploying behind a trusted reverse proxy that overwrites or appends the peer IP to `X-Forwarded-For`. The app uses only the last entry as the source. With the setting off, all requests share one source bucket. Missing or invalid source addresses also use a shared bucket. Every failed credential check counts toward the same global failure window across login and manual sync.

Failed credentials incur `min(2000, 300 + 100 × max(S − 1, G − 30))` milliseconds of delay, where `S` and `G` count source and global failures in the last 60 seconds, including the current failure. Valid credentials bypass the failure delay.

## Testing & Verification

```bash
npm run lint && npm run typecheck && npm test && npm run test:production
```

`npm test` runs the full suite, including the production assembly test, which **unconditionally rebuilds** the app before exercising it (a prebuilt bundle is only reused when the suite is invoked through `npm run test:production`, which builds a fresh production bundle first and then checks the login redirect through `next start`).

## Attribution & License Compliance

Intelligence scores and official cost-per-task data are sourced from [Artificial Analysis](https://artificialanalysis.ai/). Free-tier API data is intended for personal/internal analysis and must display visible attribution to Artificial Analysis; public redistribution of the full dataset is restricted without explicit permission. Production requires an explicit `PRIVATE_MODE` and independent viewer and session credentials. Set `PRIVATE_MODE=true` to require viewer login.
