# clipdrop — clipboard sharing across devices

Blazing fast text sharing between computer ↔ iPhone / Android. No login.
Create a session (`/s/xyz`), open it on the other device, paste → copy.

Stack: Cloudflare Workers + Durable Objects (1 DO = 1 session) + static SPA + Node CLI.

## Quick start

```bash
npm install
npm --prefix web install
npm run build        # builds web/dist
cf dev               # local: http://localhost:8787
cf deploy            # -> https://clipdrop.<account>.workers.dev
```

## Use

Web:
1. Open `/` → **New session** → `/s/k7xq2p`
2. Open same URL on phone (QR or type code)
3. Paste below, copy on the other side. WS live, 12h auto-delete.

CLI:
```bash
node cli/src/index.js new --host https://clipdrop.xxx.workers.dev
echo "hello from laptop" | node cli/src/index.js push -s k7xq2p --host ...
node cli/src/index.js pull -s k7xq2p --host ...
node cli/src/index.js pull -s k7xq2p --watch --host ...
```

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
- `wrangler.jsonc` — `clipdrop` worker, assets `./web/dist`, DO binding `ROOM`
