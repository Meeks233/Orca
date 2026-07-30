# Changelog

Notable changes per release. Versions follow [Semantic Versioning](https://semver.org).

The section for a version becomes the body of its GitHub Release, so each
heading must read `## MAJOR.MINOR.PATCH — YYYY-MM-DD`; `scripts/release.zsh`
refuses to tag a version that has no section here.

## 0.2.0 — 2026-07-30

### Browsing

- Two ways into the library, on a bottom nav. **Timeline** is every item, flat
  and newest first under a day heading, paging a tile at a time — playlists are
  deliberately not folded here. **Lists** is one card per collection, opening
  into its members. Cards remains in Settings > Appearance, unchanged.
- A tile is the card's own thumbnail block in a grid cell, so play, image zoom,
  the privacy blur, the duration pill, multi-select and the progress ring all
  work without a second implementation.
- `GET /api/collections`, plus a `post=` filter beside `playlist=`, so "which
  lists do I have" is one windowed query instead of a walk of the paged history.
- The top of a browsing route is for finding things: the submit box gives its
  slot to the search row.

### Clients

- One offline state, decided in one place and read everywhere. Any request that
  never comes back marks the client offline; writes are gated on that state,
  reads never are. Reporting is one amber bar under the topbar plus one failure
  surface inside the viewer, shared by video and stills — the player stays open
  and picks the media back up when the link returns.
- A page opened past the connection limit now says "too many pages open" in a
  modal instead of sitting blank. The server counts terminals and serves five at
  once, one below the browser's six-connection ceiling, so the over-limit page's
  heartbeat still gets through to be answered. Closing another tab reconnects it
  on its own, no reload.
- The card's action row collapses behind one overflow menu: the single action
  that state is asking for stays on the card, the rest become named rows in a
  kebab popover. Group headers get the same treatment.
- Lifting the privacy blur is momentary — no longer persisted, and re-armed
  after the app has been backgrounded longer than the new Settings > Privacy
  grace period. On desktop the pointer leaving the page starts that same grace
  period, so another window on top re-blurs.
- Save offers to give the space back when the file is already on the device, and
  refuses a second tap while a save is in flight.
- Tighter cards and topbar, optically sized topbar glyphs, and the uploader name
  aligned to the title's first-line edge.

### Fixes

- Back inside a list went to the timeline and then quit; routes are now peeled
  in `dismissTopLayer` with the history write deferred past the sentinel.
- `filter: blur()` samples outside the element, leaving a pale rim around every
  full-bleed tile. Overscale and clip.
- Blurring a fold's layers individually blurred the stack's own blur a second
  time; the blur belongs on the wrapper.
- The orca in the launcher icon is optically centered — its mass sits right, so
  under the adaptive icon's circular mask it read as drifting.

## 0.1.0 — 2026-07-27

First release.

### Server

- Rust/Axum service that submits URLs to `yt-dlp`, probes metadata, deduplicates
  against a persistent archive, and downloads in the background.
- SQLite control plane with searchable, paginated history; retry, cancellation,
  resolution variants, and stream-only records.
- Playlists, multi-video posts, cookie jars, subtitles, thumbnails, format
  selection, polite pacing, rate limits, and concurrent fragments.
- Local range streaming, an authenticated online playback proxy, and rotating
  tokenless public share links with expiry and access counts.
- Per-site enablement, resolution defaults, harvested site icons, and batch
  operations.
- Seal backup import.

### Clients

- TypeScript PWA embedded in the binary, in English, Simplified Chinese, and
  Traditional Chinese, with a gesture-driven media viewer (swipe, pinch-zoom,
  pan, double-tap) and a global privacy blur.
- Android/Tauri shell with a share target, native permissions, playback, and
  progress notifications.
- Tampermonkey/Violentmonkey userscript that injects download and status
  controls on registered sites, harvests favicons, and bridges the token from
  the Orca dashboard.

### Security

- Owner token gates every route. Web, Android, and userscript clients derive an
  AES-GCM key from it and encrypt authenticated JSON traffic over an ephemeral
  P-256 ECDH channel.
- Self-registered clients start pending; once approved their credential can only
  submit URLs.
- Item routes use random 96/128-bit slugs, never sequential database IDs.
- Hostnames resolve over DNS-over-HTTPS with the verified address pinned into
  the connection, so a rebinding answer cannot slip in between; `yt-dlp` is
  routed through a loopback proxy so it resolves the same way. Answers pointing
  at private addresses are refused unless `ORCA_ALLOW_PRIVATE_DNS=1`.

### Packaging

- Non-root OCI image with a health check, a pinned and checksum-verified
  `yt-dlp`, SBOM, and provenance, published to GHCR only after CI passes.
- Signed Android APK/AAB, an F-Droid recipe built from source, and the
  userscript, all published from one tag.
