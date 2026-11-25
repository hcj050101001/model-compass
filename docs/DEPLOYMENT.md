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

## Option B: Docker Compose

```bash
cp .env.example .env
# Edit .env with strong secrets and AA_API_KEY
docker compose up -d --build
```
