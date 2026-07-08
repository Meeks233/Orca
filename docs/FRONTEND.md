# Frontend (Web UI + PWA)

A single, minimal, dependency-free web app served by the backend. No build step: plain
HTML + CSS + vanilla JS, embedded into the binary via `rust-embed` and served by `web.rs`.
Goal: submit a URL and watch/browse history from any device, installable to the home screen.

## 1. Files (`web/`)

| File | Purpose |
|---|---|
| `index.html` | App shell: token field, submit box, history list |
| `app.js` | API calls, SSE subscription, rendering, token persistence |
| `style.css` | Minimal responsive styling (mobile-first) |
| `manifest.webmanifest` | PWA metadata, `share_target`, icons |
| `sw.js` | Service worker: cache app shell, enable install/offline shell |
| `icons/` | PWA icons (192, 512) |

Served: `GET /` → `index.html`; `GET /<asset>` → matching file (auth-free, see API.md).

## 2. Token handling

- No login page. A settings field accepts the bearer token; stored in `localStorage`.
- All `fetch` calls send `Authorization: Bearer <token>`.
- SSE (`EventSource` can't set headers) uses `/api/events?token=<token>`.
- If any `/api/*` returns `401`, show the token field with an "invalid token" hint.

## 3. Views (single page)

1. **Submit bar** (top): URL input + "Download" button. On submit → `POST /api/items`.
   - Show a toast: "Queued", or "Already downloaded" when `duplicate:true`, or the probe error.
2. **History list**: `GET /api/items` (keyset paginated, infinite scroll / "load more").
   Each row: thumbnail, title, uploader, status badge, and for active rows a live progress bar.
   - Filter chips: All / Queued / Running / Completed / Failed.
   - Search box → `?q=`.
3. **Live updates**: open one `EventSource('/api/events?token=…')`; on each `ProgressEvent`
   patch the matching row by `id` (progress bar, status badge). Terminal status finalizes it.

## 4. PWA specifics

`manifest.webmanifest` (sketch):
```json
{
  "name": "Whale", "short_name": "Whale", "start_url": "/", "display": "standalone",
  "background_color": "#0b1220", "theme_color": "#0b1220",
  "icons": [ {"src":"/icons/192.png","sizes":"192x192","type":"image/png"},
             {"src":"/icons/512.png","sizes":"512x512","type":"image/png"} ],
  "share_target": {
    "action": "/", "method": "GET",
    "params": { "url": "url", "text": "text", "title": "title" }
  }
}
```
- **Share target**: on Android/desktop, "Share → Whale" opens `/?url=<shared>`; `app.js`
  reads the `url`/`text` query param, prefills the submit box, and (if a token is stored)
  auto-submits. This is the "minimal submit端" on mobile without a native app.
- **iOS**: no Web Share Target API; users add to home screen and paste, or use a one-line
  Shortcut that `POST`s to `/api/items` with the token. Document both in README.

## 5. Service worker scope

Keep it conservative: cache only the **app shell** (html/js/css/icons) for install +
offline-open. **Never** cache `/api/*` responses (data must be live). `sw.js` uses a
network-first (or network-only) strategy for `/api/*` and cache-first for the shell.

## 6. Non-goals (v1)

- No client-side framework, no bundler, no auth UI beyond the token field.
- No in-browser video playback of results (files land in `WHALE_DOWNLOAD_DIR`; serving media
  is out of scope — could be added as a static file route later).
