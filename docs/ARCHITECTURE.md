# Architecture

## 1. Goals & constraints

- **Self-hosted cloud downloader** wrapping `yt-dlp`, deployed as a single Docker container.
- **Minimal, multi-platform client** = a Web UI + PWA served by the backend. No native apps.
- **Defaults do the right thing** with just a URL: submit-only, auto-dedup, highest quality,
  download **all** subtitles and embed them, Seal-style filenames.
- **Scales to tens of thousands of records** without pain (SQLite + in-memory dedup set).
- **Reproducible images, no hot-update**: `yt-dlp`/`ffmpeg` versions are baked in. Upstream
  yt-dlp release → GitHub Action builds & pushes a new image.
- **Import old Seal history** so previously-downloaded media dedups correctly.

## 2. Component overview

```
┌──────────────────────────── whale (single binary) ───────────────────────────┐
│                                                                               │
│  CLI dispatch (main.rs)                                                       │
│    ├── serve      → runs the HTTP server + worker                             │
│    └── import     → imports a Seal backup JSON                                │
│                                                                               │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────┐   ┌────────────────┐  │
│  │  api (Axum) │──▶│    queue     │──▶│    ytdlp       │──▶│   filesystem   │  │
│  │  REST + SSE │   │ tokio worker │   │ subprocess     │   │  /downloads    │  │
│  │  bearer auth│   │  + semaphore │   │ probe+download │   └────────────────┘  │
│  └──────┬──────┘   └──────┬───────┘   └──────┬─────────┘                       │
│         │                 │                  │                                 │
│         ▼                 ▼                  ▼                                 │
│  ┌──────────────────────────────────────────────────┐   ┌──────────────────┐ │
│  │                    db (SQLite)                     │   │   archive.txt    │ │
│  │   items table (history + live job state)          │◀─▶│ in-mem HashSet + │ │
│  │   + FTS5 search (optional)                         │   │ append-only file │ │
│  └──────────────────────────────────────────────────┘   └──────────────────┘ │
│                                                                               │
│  web/ (embedded static assets: index.html, app.js, manifest, sw.js)          │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 3. Request → download data flow

1. **Submit** — client `POST /api/items {url}` (bearer token required).
2. **Probe** — server runs `yt-dlp --dump-json --skip-download <url>` to get
   `extractor`, `id`, `title`, `uploader`, `thumbnail`, `duration`, `webpage_url`.
   Compute `archive_key = "{extractor} {id}"` (matches yt-dlp's archive line format).
3. **Dedup** — check `archive_key` against the in-memory set (backed by `items.archive_key`
   UNIQUE + the archive file). If present → return the existing item with `duplicate: true`,
   do **not** re-download.
4. **Enqueue** — insert an `items` row with `status = queued`; push job id onto the worker.
5. **Download** — worker (bounded by a semaphore = `WHALE_CONCURRENCY`) runs `yt-dlp` with
   the full option set (best video+audio, merge to MKV, embed all subs + metadata + thumbnail,
   Seal-style `-o` template, `--download-archive`). Progress is parsed and broadcast via SSE.
6. **Finalize** — on success: record `filepath`, `filesize`, `status = completed`,
   append `archive_key` to the archive set/file. On failure: `status = failed` + `error`.

The probe (step 2) is a lightweight metadata call; it is what lets dedup be exact
(`extractor:id`) and lets the UI show title/thumbnail immediately, before the download runs.

## 4. Key technical decisions (resolved)

| Decision | Choice | Rationale |
|---|---|---|
| HTTP framework | **Axum** | Mainstream, tokio-native, clean extractor/middleware model |
| Async runtime | **Tokio** | Required by Axum; subprocess + queue are async |
| DB | **SQLite** (via `sqlx` or `rusqlite`) | Single file, zero-ops, trivially handles 10k–100k rows |
| Dedup | **`extractor:id` primary, URL fallback** | Exact across platforms; see DATABASE.md §Dedup |
| Client | **Web UI + PWA** served by backend | Zero-install, truly multi-platform, share-target on mobile |
| Container format | **MKV** (default) | Holds any codec + embeds all subtitle formats faithfully |
| Quality | `-f bv*+ba/b` | Highest video+audio |
| Subtitles | `--write-subs --sub-langs all --embed-subs` | Download all + embed; auto-subs off by default |
| Filename | `%(uploader,channel|Unknown)s - %(title).150B [%(id)s].%(ext)s` | Seal-style author-title-[id]; `[id]` prevents collisions |
| Auth | Single static bearer token | Simplest thing that is actually secure enough for personal use |
| Progress → UI | **SSE** (`GET /api/events`) | Push updates without polling; falls back to polling if needed |
| yt-dlp updates | Baked into image; **GH Action** rebuild on new release | Reproducible; "update = new image" |

> Note on `sqlx` vs `rusqlite`: either is acceptable. `sqlx` gives async + compile-time
> checked queries but needs `DATABASE_URL` at build time (or `sqlx prepare` offline data).
> `rusqlite` is sync (wrap in `spawn_blocking`) but simpler to build. **Default recommendation:
> `sqlx` with the `sqlite` + `runtime-tokio` features and the offline (`.sqlx`) query cache**
> so the Docker build needs no live DB. The implementer of the `db` module decides and
> documents it; nothing else in the codebase depends on the choice beyond `db`'s public API.

## 5. Concurrency & durability

- Downloads run under a `tokio::sync::Semaphore` sized to `WHALE_CONCURRENCY` (default 2).
- Job state lives in SQLite, so a restart can recover: on startup, any `running` rows are
  reset to `queued` and re-enqueued (idempotent because `--download-archive` + `archive_key`
  prevent duplicate files/records).
- Live progress (percent/speed/ETA) is **in-memory only** and pushed over SSE — never written
  per-tick to SQLite (avoids write amplification at scale).

## 6. Failure & edge handling (design intent)

- **Playlists**: v1 treats a playlist URL as-is via yt-dlp; each entry gets its own
  `archive_key` and row. (Probe uses `--dump-json` which emits one JSON object per entry.)
  Enqueue one job per entry. Flagged as a v1 scope item in WORKPLAN.
- **Live / unsupported URLs**: probe failure → return 422 with yt-dlp's stderr summary; no row.
- **Partial downloads**: yt-dlp `.part`/temp files live in a temp subdir; only atomically
  moved/exposed on success.
- **Duplicate submit while queued**: `archive_key` UNIQUE + set check makes a second submit a
  no-op returning the in-flight item.
```
