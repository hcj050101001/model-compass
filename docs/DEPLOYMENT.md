# Deployment Guide

## Option A: Systemd + Caddy (Bare-Metal Linux)

1. Configure `.env` in `/home/ubuntu/apps/llm-frontier/.env` (`chmod 600`):
   - Set `PRIVATE_MODE=true`, `ACCESS_PASSWORD`, `ADMIN_TOKEN`, `SESSION_SECRET`.
   - Set `AA_API_KEY` and `DEMO_MODE=false` when ready for live data.
2. Build & seed:
   ```bash
   cd /home/ubuntu/apps/llm-frontier
   npm install
   NODE_OPTIONS="--max-old-space-size=1536" npm run build
   npm run db:migrate
   npm run seed:demo # or npm run sync:data with live AA_API_KEY
   ```
3. Run via systemd (`llm-frontier.service`) bound to `127.0.0.1:3100` and schedule hourly sync via `llm-frontier-sync.timer`.
4. Reverse proxy in Caddy:
   ```caddy
   llm.nianhub.com {
       reverse_proxy 127.0.0.1:3100
   }
   ```
   Reload Caddy after DNS A record points to the server IP.

## Option B: Docker Compose (web + worker images)

Two images are built from the same Dockerfile: the web image (target
`runner`, Next.js standalone) and the worker image (target `worker`,
production dependencies only — installed at build time; the running
container never downloads packages). Both run as UID 1001 and share one
persistent volume at `/app/data` holding the SQLite database and the
immutable publication files (`snapshots/<snapshot-id>.json`).

Bootstrap sequence (each step must succeed before the next):

```bash
cp .env.example .env
# Edit .env: strong secrets, AA_API_KEY, DEMO_MODE=false,
# DATABASE_URL=file:/app/data/frontier.db (absolute path)
docker compose build
docker compose run --rm --no-deps sync-worker npm run preflight
docker compose run --rm --no-deps sync-worker npm run db:migrate
docker compose run --rm --no-deps sync-worker npm run sync:data
docker compose run --rm --no-deps sync-worker npm run snapshot:verify
docker compose up -d web
curl -fsS http://127.0.0.1:3100/api/health   # 200 {"status":"ok"} (liveness only)
curl -fsS http://127.0.0.1:3100/api/ready    # 200 {"status":"ready"} after bootstrap
docker compose up -d sync-worker
```

Probes: `/api/health` answers process liveness only. `/api/ready`
returns 503 with a reason code until the active snapshot is a verified,
non-demo, coverage-passing publication whose registered file is readable
and whose last successful verification fetch is within
`MAX_SNAPSHOT_AGE_MINUTES` (1440). Gate traffic on `/api/ready`, not on
`/api/health`.

Scheduling: `scripts/sync-worker.ts` in the worker container is the only
production scheduler. `DATA_SYNC_INTERVAL_MINUTES` drives both its
schedule and the status page display. The GitHub workflow's publication
job is a gated distribution path (`AA_GIT_PUBLICATION_APPROVED`, default
off), not a site scheduler; do not run host cron/systemd sync timers
alongside the worker.

Note: the systemd timer mentioned in Option A predates the worker; when
the container deployment is used, the worker replaces it — never run
both.
