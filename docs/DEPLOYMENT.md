# Deployment Guide

## Option A: Bare-Metal Linux + Caddy (no systemd units ship with this repository)

1. Configure `.env` in `/home/ubuntu/apps/llm-frontier/.env` (`chmod 600`):
   - Set `PRIVATE_MODE=true`, `ACCESS_PASSWORD`, `ADMIN_TOKEN`, `SESSION_SECRET`.
   - Set `AA_API_KEY` and `DEMO_MODE=false` when ready for live data.
2. Build & seed:
   ```bash
   cd /home/ubuntu/apps/llm-frontier
   npm install
   NODE_OPTIONS="--max-old-space-size=1536" npm run build
   npm run seed:demo # or npm run sync:data with live AA_API_KEY
   ```
3. Run the web service bound to `127.0.0.1:3100` with `npm run start`. No systemd units ship with this repository: if you manage the process with systemd, cron, or another supervisor, write that unit yourself. Schedule data sync from the operator environment with the CLI — the CLI does not auto-load `.env`, so load it explicitly first (`set -a; . ./.env; set +a; npm run sync:data`) — or through the protected server-side admin API; the settings page only displays sync status and never accepts an admin token in the browser. Under Docker Compose the two services are named `web` and `sync-worker`, and the sync interval is driven by `DATA_SYNC_INTERVAL_MINUTES` (the same value the status page displays).
4. Reverse proxy in Caddy:
   ```caddy
   llm.nianhub.com {
       reverse_proxy 127.0.0.1:3100
   }
   ```
   Reload Caddy after DNS A record points to the server IP.

## Option B: Docker Compose

```bash
cp .env.example .env
# Edit .env with strong secrets and AA_API_KEY
docker compose up -d --build
```
