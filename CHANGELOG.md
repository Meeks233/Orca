# Changelog

Notable changes per release. Versions follow [Semantic Versioning](https://semver.org).

The section for a version becomes the body of its GitHub Release, so each
heading must read `## MAJOR.MINOR.PATCH — YYYY-MM-DD`; `scripts/release.zsh`
refuses to tag a version that has no section here.

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
