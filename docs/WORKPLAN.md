# Work plan — parallel implementation

This project is designed so multiple conversations can implement it concurrently with minimal
conflict. The trick is: **land the foundation first, freeze the contracts, then fan out.**

## Phase 0 — Foundation (do this ONE conversation first, then freeze)

Everything else imports these. Keep it small; get it merged before starting Phase 1.

- `Cargo.toml` (deps per MODULES.md §5) + `Cargo.lock`.
- `src/types.rs` — all shared DTOs verbatim from MODULES.md §2.
- `src/error.rs` — `AppError` enum + `IntoResponse` mapping to API.md error table.
- `src/config.rs` — `Config` + `from_env()` per CONFIG.md.
- `src/main.rs` — `clap` CLI skeleton: `serve` / `import` subcommands wired to stubs.
- `migrations/0001_init.sql` — schema from DATABASE.md §2.
- Empty module files (`db/mod.rs`, `archive.rs`, `ytdlp/mod.rs`, `queue.rs`, `api/mod.rs`,
  `seal_import.rs`, `web.rs`) with the public signatures from MODULES.md §3 as `todo!()` stubs.

**Exit criteria:** `cargo build` compiles with stubs. Contracts (`types.rs`, module signatures,
SQL schema, API.md) are now frozen — changes require updating the doc + a heads-up to others.

## Phase 1 — Parallel workstreams (independent, build on Phase 0)

Each is a self-contained conversation. Dependencies are only on the *frozen* Phase-0 interfaces.

| # | Workstream | Owns files | Depends on | Verify |
|---|---|---|---|---|
| A | **DB layer** | `src/db/*`, migrations | types, config | unit tests: insert/dedup/list/paging against a temp sqlite |
| B | **Archive** | `src/archive.rs` | types | unit test: load+seed+contains+insert round-trips file |
| C | **yt-dlp options** | `src/ytdlp/options.rs` | config, types | unit test: arg vectors match DOWNLOAD_PIPELINE.md exactly |
| D | **yt-dlp probe** | `src/ytdlp/metadata.rs` | config, types, C | integration test w/ a real URL (or recorded JSON fixture) |
| E | **yt-dlp download** | `src/ytdlp/download.rs` | config, types, C | test progress parsing on captured yt-dlp output lines |
| F | **Frontend** | `web/*` | API.md only | manual: load page, submit, watch SSE row update |
| G | **Docker + CI** | `Dockerfile`, `.github/workflows/*`, `compose` | nothing (uses binary) | image builds; healthcheck passes |
| H | **Seal import** | `src/seal_import.rs` | db (A), archive (B), types | test: parse sample backup → correct archive_keys + outcome |

Workstreams C/D/E touch the same `ytdlp/` dir — split by file (options.rs / metadata.rs /
download.rs) so they don't collide, or do C first then D+E together. A, B, F, G, H are fully
independent of each other.

## Phase 2 — Integration (one conversation, after Phase 1 lands)

Wire the frozen pieces together. Small glue, high leverage.

- `src/queue.rs` — worker loop using db (A) + archive (B) + download (E) + broadcast (per
  DOWNLOAD_PIPELINE.md §4). Startup recovery (DATABASE.md §4).
- `src/api/*` — router, bearer middleware (auth.rs), item handlers (submit/list/get/retry/
  delete) using db + archive + queue + probe (D), SSE handler (events.rs) using the broadcast.
- `src/web.rs` — `rust-embed` + static serving of `web/` (F).
- `src/main.rs` — flesh out `serve` (build `AppState`, spawn queue, `axum::serve`) and `import`
  (call `seal_import::run_import`, print outcome).

**Verify (end-to-end):** submit a URL → row appears queued → SSE shows progress → file lands in
`WHALE_DOWNLOAD_DIR` with the Seal-style name → re-submitting the same URL returns
`duplicate:true` with no new download → `whale import <sample>` dedups a known id.

## Phase 3 — Polish (optional, parallelizable)

- FTS5 search migration + query path (DATABASE.md §2).
- Playlist batch response shape (API.md `POST /api/items` array form).
- iOS Shortcut + README usage docs.
- Static media serving route (play/download finished files) — if wanted.

## Coordination rules

1. **Don't edit another workstream's files.** If you need a change to a frozen interface,
   update the relevant doc and flag it — treat `types.rs` / API.md / the SQL schema as the
   source of truth.
2. **Match the signatures in MODULES.md §3 exactly** so integration is mechanical.
3. **Every workstream ships its own tests** per the Verify column; integration assumes green.
4. Keep changes surgical (per repo `CLAUDE.md`): no speculative features, no refactoring of
   others' code, minimal deps beyond MODULES.md §5.

## Suggested prompts for the parallel conversations

Each conversation can be opened with something like:

> "Implement workstream **A (DB layer)** of the Whale project. Read `docs/MODULES.md`,
> `docs/DATABASE.md`, and `docs/types` contract. Implement `src/db/*` and the migration to
> match the frozen `Db` public API exactly, with unit tests for insert/dedup/list/pagination.
> Do not touch files outside `src/db/` and `migrations/`."

Repeat per workstream, swapping the letter, the owned files, and the relevant docs.
