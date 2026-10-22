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

## Security

Sessions are **end-to-end encrypted** (AES-256-GCM). When a session is created, the
client generates a 256-bit key and puts it in the URL fragment (`/s/<id>#<key>`).
Fragments are never sent to the server or written to request logs, so the server —
and anyone watching the network or the infrastructure — only ever stores and relays
ciphertext. Message text, file bytes, and file metadata (name/mime/size) are all
encrypted client-side; only the session ID and a coarse device label travel in the
clear. Files are decrypted in the browser/CLI after download.

To join a session you need the **full link** (or its QR) — the code alone is not
enough, because the key never leaves the devices that have it.

Additional hardening:

- Session IDs are 10 chars (~50 bits) from a CSPRNG — not brute-forceable at scale.
- Per-IP token-bucket rate limits on session creation, reads (history/WS/downloads)
  and writes (messages/uploads) — enumeration scans get 429s.
- No CORS: the API is same-origin only; no other website can read session content.
- 12h TTL + 1h idle alarm wipe the DO storage and every R2 object.
- The service worker never caches `/api/*` responses.


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
1. Open `/` → **New session** → `/s/k7xq2pabcdef#<key>` (the `#key` part stays on your devices)
2. Open the same link on your phone (QR or paste — a bare code won't work without the key)
3. Paste below, copy on the other side. WS live, 12h auto-delete. Everything is E2E encrypted.

CLI:
```bash
HOST=https://clipdrop.idarciooliveira.workers.dev
node cli/src/index.js new --host "$HOST"     # prints the URL with #key, saves session + key locally
echo "hello from laptop" | node cli/src/index.js push --host "$HOST"
node cli/src/index.js pull --host "$HOST"
node cli/src/index.js pull --watch --host "$HOST"
```

The key is saved to `~/.config/clipdrop/config.json` by `new`; other machines need
`--key <key>` (the part after `#` in the link).

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

All request/response bodies below are what the **server** sees — message text and
file bytes/metadata are client-encrypted `enc.v1.*` envelopes (AES-256-GCM), so the
server stores and relays ciphertext only.

- `POST /api/sessions {ttlHours?}` → `{id, url, expiresAt}`
- `GET /api/s/:id/history` → `{messages, files, expiresAt}` (encrypted payloads)
- `POST /api/s/:id/messages {text, device}` → `{msg}` (`text` = `enc.v1.<iv>.<ct>`)
- `POST /api/s/:id/files` (multipart, field `file` = encrypted bytes, filename = encrypted metadata envelope, + `device`) → `{file}` (25MB max)
- `GET /api/s/:id/files/:fileId` → encrypted bytes (`Content-Disposition: attachment`, Range supported)
- `WS /api/s/:id/ws?device=x` → `{type:'hello'|'msg'|'file'|'peers'}` (encrypted payloads)

Limits: 10-char IDs, 64KB/msg plaintext (128KB envelope), 200 msgs/session, 25MB/file,
50 files / 200MB per session, 12h TTL (alarm wipes DO + R2 keys). Per-IP rate limits:
10 sessions/hour, 10 reads/s, 2 writes/s (burst 600/120).

## Project layout

- `src/worker.ts` — Worker + `SessionRoom` DO (hibernation WS) + `RateGate` DO (per-IP token buckets)
- `web/src/crypto.ts` — browser E2EE (AES-256-GCM, key-in-fragment)
- `web/` — vanilla Vite TS SPA
- `cli/src/index.js` — zero-dep Node CLI (node:crypto E2EE, interops with the web client)
- `test/crypto.test.js` — browser ↔ CLI crypto contract tests (`npm test`)
- `wrangler.jsonc` — source of truth (migrated via `cf migrate`)
- `cloudflare.config.ts` — cf deploy config (entrypoint, DO exports, assets `./web/dist`, `runWorkerFirst: ["/api/*"]`)
- `wrangler.config.ts` — generated assets shim
