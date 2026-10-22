# clipdrop — clipboard sharing across devices

> **Live:** https://clipdrop.idarciooliveira.workers.dev

Blazing fast text sharing between computer ↔ iPhone / Android. No login.
Create a session (`/s/xyz`), open it on the other device, paste → copy.

Stack: Cloudflare Workers + Durable Objects (1 DO = 1 session) + static SPA + Node CLI.

## Quick start

```bash
npm install
npm --prefix web install
npm run build        # builds web/dist
npx wrangler dev --local --port 8787   # local API+web
cf deploy            # -> https://clipdrop.<account>.workers.dev
```

## Use

Web:
1. Open `/` → **New session** → `/s/k7xq2p`
2. Open same URL on phone (QR or type code)
3. Paste below, copy on the other side. WS live, 12h auto-delete.

CLI:
```bash
HOST=https://clipdrop.idarciooliveira.workers.dev
node cli/src/index.js new --host $HOST
echo "hello from laptop" | node cli/src/index.js push -s k7xq2p --host $HOST
node cli/src/index.js pull -s k7xq2p --host $HOST
node cli/src/index.js pull -s k7xq2p --watch --host $HOST
```

## Proof

Production verified 2026-10-22 — see `proof/`:

- `01-home-mobile.png` — landing, New session + join by code
- `02-room-mobile.png` — session with QR, expiry countdown, copy buttons, link detection
- `03-room-desktop.png` — same session on desktop (realtime sync)

## API

- `POST /api/sessions {ttlHours?}` → `{id, url, expiresAt}`
- `GET /api/s/:id/history` → `{messages, expiresAt}`
- `POST /api/s/:id/messages {text, device}` → `{msg}`
- `WS /api/s/:id/ws?device=x` → `{type:'hello'|'msg'|'peers'}`

Limits: 6-char IDs, 64KB/msg, 200 msgs/session, 12h TTL (alarm wipes DO).

## Project layout

- `src/worker.ts` — Worker + `SessionRoom` DO (hibernation WS)
- `web/` — vanilla Vite TS SPA
- `cli/src/index.js` — zero-dep Node CLI
- `wrangler.jsonc` — source of truth (migrated via `cf migrate`)
- `cloudflare.config.ts` — cf deploy config (entrypoint, DO export, assets `./web/dist`, `runWorkerFirst: ["/api/*"]`)
- `wrangler.config.ts` — generated assets shim
