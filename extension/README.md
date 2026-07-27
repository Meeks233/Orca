# Orca userscript

Submit videos to your self-hosted [Orca](../README.md) over the **same
end-to-end-encrypted channel** the web UI uses (OSC v2 — ephemeral P-256 ECDH +
HKDF-SHA256 with `SHA256(token)` as a pre-shared key, AES-256-GCM envelopes), and
download them straight from any video page.

Ships as a **single self-contained `.user.js`** for Tampermonkey / Violentmonkey.
The browser extension this directory once also built has been **retired** — the
userscript is the only client, and owns the content script, API client and OSC
crypto outright.

## What it does

- **In-page download button.** A cloud-download button is mounted on video
  pages/posts and on recognised thumbnails. Click → spinner → progress ring →
  cloud-check (click it to open the finished video in the Orca web app) or X on
  failure. A video already in your library wears the check from the start.
- **Multi-select.** Where a page shows a grid of videos, a bottom-right
  **Select** toggle turns the thumbnails into checkboxes — with *All*, *All in
  list*, shift-click range selection — and downloads just the ticked ones. The
  stack automatically climbs clear of the page's own floating buttons (X's Grok
  button, a back-to-top bubble) rather than covering them.
- **Download all.** On a real collection the server can expand whole (a YouTube
  `/playlist?list=…`, or a watch page's `?list=` queue) a **Download all · N**
  pill submits the collection in one request.
- **X / Twitter thread saving.** On an X/Twitter post-detail page, a **Save
  thread · N** control appears when the rendered contiguous posts by the thread
  author contain media. It submits only those image/video posts, in reading
  order, and records them as one `x-thread:<root-post-id>` group. It deliberately
  stops before replies by other authors; scroll or expand the thread first when X
  has not rendered all continuation posts yet.
- **One-click cookie import.** A menu command uploads the current site's cookies
  to your Orca server so yt-dlp can fetch logged-in content (see below).

## Where videos are recognised

Two tiers, because the script runs on `*://*/*` and must not decorate arbitrary
websites:

- **Built-in adapters** (`src/content/sites.ts`) tune YouTube and X/Twitter,
  whose DOM and URL shapes need per-site knowledge.
- **Structural recognition** applies on any host the **server's website
  registry** lists (`GET /api/websites`): a thumbnail-sized, same-site link whose
  path carries an id-like segment (or an id-like query param) is a video. That is
  what lights up Vimeo (`/1210585745`), Reddit (`/r/x/comments/<id>/…`), XVideos
  (`/video.<id>/…`), Pornhub (`/view_video.php?viewkey=…`) and the rest without a
  line of per-site code.
- **Everywhere else** only the conservative URL shapes (`/watch?v=`, `/video/<id>`,
  `/status/<id>`, …) count, so an unrelated site gets nothing.

Add a platform the registry doesn't cover via **Orca: import site adapters
(JSON)** in the userscript menu — see `UserSiteAdapter` in `src/lib/types.ts`.

## Build

```sh
npm install
npm run dist      # typecheck -> dist-userscript/orca.user.js
npm run build     # esbuild only
```

Or from the repo root: `scripts/pack-clients.zsh` (`--fast` to skip the
typecheck). The output is git-ignored.

`npm run verify:e2ee` drives the crypto against a live server (`ORCA_BASE`,
`ORCA_TOKEN`) as an end-to-end handshake / seal / open check.

## Install

**Released build** — open
<https://github.com/Meeks233/Orca/releases/latest/download/orca.user.js>; the
manager intercepts `*.user.js` and offers to install it. The banner's
`@updateURL` points at that same `latest` URL, so installed copies pick up
future releases on their own.

**Local build** — drag `dist-userscript/orca.user.js` into Tampermonkey /
Violentmonkey, or open it as a `file://` URL. Re-import after a rebuild to pick
up changes.

## Architecture

| File | Role |
|---|---|
| `src/lib/e2ee.ts` | OSC handshake + AEAD envelope + media-chunk decrypt (WebCrypto) |
| `src/lib/api.ts` | `OrcaClient`: sealed request wrapper, submit, lookup, SSE-over-fetch |
| `src/content/detect.ts` | Site scanning, button mounting, per-button state machine, multi-select |
| `src/content/sites.ts` | Site adapters: which links are videos, and their canonical URLs |
| `src/userscript/shim.ts` | The runtime: recreates the `browser.*` sliver `detect.ts` talks to, backed by the real `OrcaClient`; token bridge; menu commands; routes API calls through `GM_xmlhttpRequest` |
| `src/userscript/main.ts` | Entry point — imports the shim (first) then the content script |
| `build-userscript.ts` | esbuild → one `.user.js` with the metadata header; inlines `inject.css` |

`detect.ts` still talks to a `browser.runtime`-shaped object — now the shim's —
which is why the Firefox WebExtension typings remain a dev dependency.

## Token flow (zero-config)

There is no popup. Instead:

- On your **Orca dashboard** page, the script reads `localStorage.orca_token` and
  mirrors it (plus the server base) into the userscript manager's cross-origin GM
  store — so video pages on other sites can use it.
- If the dashboard ever loses its token but the GM store still has one for that
  server, the script **reverse-injects** it back into `localStorage` and reloads,
  so the dashboard boots logged in again (guarded against reload loops).

So: log in to your Orca web app once, and the button starts working everywhere.
Token changes made later on the dashboard are picked up live — a `storage`
listener for other tabs, plus a light poll on the dashboard page for same-tab
edits the event can't see. Because API calls go over `GM_xmlhttpRequest`
(declared `@connect *`), the E2EE channel reaches a self-hosted server on any
origin — LAN, localhost or a domain — without CORS / Private-Network-Access
friction.

## Menu commands

The userscript-manager menu offers:

- **set server + token** — manual config for anyone who hasn't opened the
  dashboard, or to reset a stale token. Validates with a real handshake.
- **show current config** / **clear config**.
- **import site adapters (JSON)** — teach it a platform the registry misses.
- **import cookies for this site** — see below.

## Cookie import

yt-dlp needs your own cookies to fetch anything behind a login (a private video,
an age gate, a members-only post). **Orca: import cookies for this site** files
the current site's cookies under the matching entry in the server's website
registry (creating one if none matches) and uploads them as a Netscape
`cookies.txt` over the sealed channel. It asks for confirmation first, and the
cookies go nowhere but your own server.

**Manager support matters.** With `GM_cookie` (Tampermonkey ≥4.13, Violentmonkey
≥2.15) the import includes **HttpOnly** cookies — the session cookies most logins
actually rely on. Without it the script falls back to `document.cookie`, which
cannot see them; the import still runs but says so explicitly, and such a login
will not authenticate. Import from the Orca web app instead in that case.

## Notes

There is no SSE fan-out in the userscript; `detect.ts`'s built-in poll fallback
drives the live progress ring.
