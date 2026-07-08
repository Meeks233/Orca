# Whale 🐳

A self-hosted, Docker-based cloud downloader inspired by [Seal](https://github.com/JunkFood02/Seal).
You submit a URL from any device; the server calls `yt-dlp` to download it at the highest
quality with all subtitles embedded, dedups against your history, and files it away in
Seal-style naming. A minimal Web UI + PWA is the client — no app install required.

- **Backend:** Rust (Axum + Tokio), single binary, single container.
- **Downloader:** `yt-dlp` + `ffmpeg`, baked into the image (no hot-update; a new yt-dlp
  release → a new image, built automatically by GitHub Actions).
- **Store:** SQLite for rich history/UI + a yt-dlp `--download-archive` file for O(1) dedup.
- **Auth:** single static bearer token.
- **Import:** one command to import your existing Seal backup so old records dedup correctly.

## Status

This repository currently contains the **design documents** only. Implementation is split
into parallel workstreams — see [`docs/WORKPLAN.md`](docs/WORKPLAN.md).

## Documents

| Doc | What it covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, data flow, tech decisions |
| [MODULES.md](docs/MODULES.md) | Crate layout, module boundaries, **shared contract types** |
| [DATABASE.md](docs/DATABASE.md) | SQLite schema, migrations, dedup, archive file |
| [API.md](docs/API.md) | REST + SSE contract (frozen interface) |
| [DOWNLOAD_PIPELINE.md](docs/DOWNLOAD_PIPELINE.md) | yt-dlp invocation, job queue, progress parsing |
| [SEAL_IMPORT.md](docs/SEAL_IMPORT.md) | `whale import` command spec |
| [CONFIG.md](docs/CONFIG.md) | Env vars & configuration |
| [FRONTEND.md](docs/FRONTEND.md) | Web UI + PWA spec |
| [DOCKER.md](docs/DOCKER.md) | Dockerfile + GitHub Actions auto-build |
| [WORKPLAN.md](docs/WORKPLAN.md) | How the work splits into parallel conversations |

## Quick mental model

```
 phone / desktop ──HTTP──▶  Whale (Axum)
                              │  1. probe metadata (yt-dlp --dump-json)
                              │  2. dedup by archive_key = "extractor id"
                              │  3. enqueue job (SQLite + tokio semaphore)
                              │  4. yt-dlp download → highest quality + embed subs
                              ▼
                        /downloads (Seal-style filenames)
```
