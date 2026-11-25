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

`npm test` builds the app if `.next/BUILD_ID` is missing. `npm run test:production` always builds a fresh production bundle and checks the login redirect through `next start`.

## Attribution & License Compliance

Intelligence scores and official cost-per-task data are sourced from [Artificial Analysis](https://artificialanalysis.ai/). Free-tier API data is intended for personal/internal analysis and must display visible attribution to Artificial Analysis; public redistribution of the full dataset is restricted without explicit permission. Production requires an explicit `PRIVATE_MODE` and independent viewer and session credentials. Set `PRIVATE_MODE=true` to require viewer login.
