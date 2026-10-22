<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="web/public/clipdrop-vertical-white.svg" />
    <img src="web/public/clipdrop-vertical-dark.svg" alt="clipdrop" width="160" />
  </picture>
</p>

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
SESSION=$(node cli/src/index.js new --host "$HOST")
echo "hello from laptop" | node cli/src/index.js push -s "$SESSION" --host "$HOST"
node cli/src/index.js pull -s "$SESSION" --host "$HOST"
node cli/src/index.js pull -s "$SESSION" --watch --host "$HOST"
```

## Branding

| Asset | File |
| --- | --- |
| Logo (dark) | `web/public/clipdrop-vertical-dark.svg` |
| Logo (light) | `web/public/clipdrop-vertical-white.svg` |
| Favicon | `web/public/icon.svg` (the dark logo; light-scheme browsers get the white one) |
| App mark (no wordmark) | `web/public/mark.svg` |
| PWA icons | `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` |

Palette comes from the logo: ink `#0A0A0A`, gray `#444`, amber `#FFAE00 → #FF8C00`. The UI follows the system dark/light setting.

## PWA

Installable on iOS, Android and desktop (manifest + maskable icons). A small service worker caches the app shell so it opens instantly and offline; `/api/*` and the WebSocket always go to the network. Bump `CACHE` in `web/public/sw.js` to invalidate.

## UI

- Clips are fixed-size cards (newest first); click a card to expand the full text, or use its Copy button.
- Composer: auto-growing, **Paste** button, Enter sends on desktop (Shift+Enter = newline). On touch devices Enter is a newline and the send button sends. Ctrl/Cmd+Enter always sends.
- QR code sits behind a button; the page reconnects and refreshes when a phone wakes the tab.

## Proof

Production verified 2026-10-22 — see `proof/`:

- `01-home-mobile.png` — landing, New session + join by code
- `02-room-mobile.png` — session with the fixed-size clip grid, expiry countdown, copy buttons
- `03-room-desktop.png` — same session on desktop (realtime sync)
- `04-clip-expanded-mobile.png` / `06-clip-expanded-desktop.png` — expanded clip
- `05-qr-mobile.png` — QR panel
- `07-room-light.png` — light theme

## API

- `POST /api/sessions {ttlHours?}` → `{id, url, expiresAt}`
- `GET /api/s/:id/history` → `{messages, files, expiresAt}`
- `POST /api/s/:id/messages {text, device}` → `{msg}`
- `POST /api/s/:id/files` (multipart, field `file`, + `device`) → `{file}` (25MB max)
- `GET /api/s/:id/files/:fileId` → bytes (`Content-Disposition: attachment`, Range supported)
- `WS /api/s/:id/ws?device=x` → `{type:'hello'|'msg'|'file'|'peers'}`

Limits: 6-char IDs, 64KB/msg, 200 msgs/session, 25MB/file, 50 files / 200MB per session, 12h TTL (alarm wipes DO + R2 keys).

## Project layout

- `src/worker.ts` — Worker + `SessionRoom` DO (hibernation WS)
- `web/` — vanilla Vite TS SPA
- `cli/src/index.js` — zero-dep Node CLI
- `wrangler.jsonc` — source of truth (migrated via `cf migrate`)
- `cloudflare.config.ts` — cf deploy config (entrypoint, DO export, assets `./web/dist`, `runWorkerFirst: ["/api/*"]`)
- `wrangler.config.ts` — generated assets shim
