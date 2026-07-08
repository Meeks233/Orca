# Modules & shared contracts

This file is the **coordination contract** for parallel implementation. Freeze the type
signatures and module boundaries here before starting parallel work. Each workstream owns a
subtree and depends only on the *public* items described here.

## 1. Source tree

```
Whale/
├── Cargo.toml
├── migrations/                 # SQL migration files (0001_init.sql, ...)
├── src/
│   ├── main.rs                 # CLI dispatch: `serve` | `import`
│   ├── config.rs               # Config struct + load-from-env
│   ├── error.rs                # AppError + IntoResponse
│   ├── types.rs                # Shared serde DTOs (the API/DB contract types)
│   ├── db/
│   │   ├── mod.rs              # Db handle, connect(), migrate()
│   │   └── queries.rs          # insert_item, find_by_archive_key, list_items, ...
│   ├── archive.rs              # Archive: in-memory HashSet + append-only file
│   ├── ytdlp/
│   │   ├── mod.rs
│   │   ├── options.rs          # build yt-dlp arg vectors from Config
│   │   ├── metadata.rs         # probe(url) -> ProbeResult
│   │   └── download.rs         # download(job) -> stream of ProgressEvent
│   ├── queue.rs                # Worker: semaphore, enqueue(), run loop, SSE broadcast
│   ├── api/
│   │   ├── mod.rs              # Router assembly + state
│   │   ├── auth.rs             # bearer-token middleware
│   │   ├── items.rs            # submit / list / get / delete / retry handlers
│   │   └── events.rs           # SSE handler
│   ├── seal_import.rs          # Seal backup parser + importer
│   └── web.rs                  # embed + serve static assets (rust-embed)
├── web/                        # static frontend source (no build step required)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── manifest.webmanifest
│   └── sw.js
└── docs/
```

## 2. Shared contract types (`src/types.rs`)

These are the DTOs crossing module boundaries and the wire. **Do not change field names
without updating API.md and DATABASE.md.** All are `#[derive(Serialize, Deserialize)]`.

```rust
/// Lifecycle status of an item (also the DB `status` column).
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status { Queued, Running, Completed, Failed, Duplicate }

/// Where a record came from.
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Source { Download, SealImport }

/// One media record — the canonical row shape returned by the API.
#[derive(Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: i64,
    pub extractor: String,            // lowercased extractor_key, e.g. "youtube"
    pub video_id: String,             // yt-dlp id
    pub archive_key: String,          // "{extractor} {video_id}"  (dedup key)
    pub title: String,
    pub uploader: Option<String>,
    pub webpage_url: String,
    pub thumbnail_url: Option<String>,
    pub duration: Option<i64>,        // seconds
    pub filepath: Option<String>,     // set when completed
    pub filesize: Option<i64>,        // bytes
    pub source: Source,
    pub status: Status,
    pub error: Option<String>,        // set when failed
    pub created_at: i64,              // unix seconds
    pub completed_at: Option<i64>,
}

/// Result of the metadata probe (yt-dlp --dump-json).
pub struct ProbeResult {
    pub extractor: String,            // from `extractor` (already lowercased)
    pub video_id: String,             // from `id`
    pub title: String,
    pub uploader: Option<String>,     // `uploader` ?? `channel`
    pub thumbnail_url: Option<String>,// `thumbnail`
    pub duration: Option<i64>,        // `duration` (rounded)
    pub webpage_url: String,          // `webpage_url`
}
impl ProbeResult {
    pub fn archive_key(&self) -> String { format!("{} {}", self.extractor, self.video_id) }
}

/// Live progress emitted during a download (SSE + in-memory only).
#[derive(Clone, Serialize)]
pub struct ProgressEvent {
    pub id: i64,                      // item id
    pub status: Status,
    pub percent: Option<f32>,         // 0.0–100.0
    pub speed: Option<String>,        // human, e.g. "3.21MiB/s"
    pub eta: Option<String>,          // human, e.g. "00:42"
}

/// Request body for POST /api/items.
#[derive(Deserialize)]
pub struct SubmitRequest {
    pub url: String,
    #[serde(default)]
    pub options: Option<SubmitOptions>,   // per-request overrides; all optional
}

#[derive(Default, Deserialize)]
pub struct SubmitOptions {
    pub audio_only: Option<bool>,     // v1: reserved, default false
    pub force: Option<bool>,          // bypass dedup, re-download
}

/// Response body for POST /api/items.
#[derive(Serialize)]
pub struct SubmitResponse {
    pub item: Item,
    pub duplicate: bool,
}
```

## 3. Module public APIs (freeze these signatures)

### `config.rs`
```rust
pub struct Config { /* see CONFIG.md for fields */ }
impl Config { pub fn from_env() -> anyhow::Result<Self>; }
```

### `db/mod.rs`
```rust
#[derive(Clone)]
pub struct Db { /* pool */ }
impl Db {
    pub async fn connect(data_dir: &Path) -> anyhow::Result<Self>;  // opens + runs migrations
    // queries live in queries.rs, exposed as inherent methods:
    pub async fn insert_probe(&self, p: &ProbeResult, source: Source) -> anyhow::Result<Item>;
    pub async fn find_by_archive_key(&self, key: &str) -> anyhow::Result<Option<Item>>;
    pub async fn set_status(&self, id: i64, status: Status, err: Option<&str>) -> anyhow::Result<()>;
    pub async fn set_completed(&self, id: i64, path: &str, size: i64) -> anyhow::Result<()>;
    pub async fn get(&self, id: i64) -> anyhow::Result<Option<Item>>;
    pub async fn list(&self, q: ListQuery) -> anyhow::Result<ListPage>;
    pub async fn delete(&self, id: i64) -> anyhow::Result<Option<Item>>;
    pub async fn reset_running_to_queued(&self) -> anyhow::Result<Vec<i64>>; // startup recovery
    pub async fn all_archive_keys(&self) -> anyhow::Result<Vec<String>>;     // to seed Archive
    pub async fn upsert_import(&self, rec: SealRecord) -> anyhow::Result<ImportOutcome>;
}
```
`ListQuery { status: Option<Status>, q: Option<String>, limit: i64, before_id: Option<i64> }`
`ListPage { items: Vec<Item>, next_cursor: Option<i64> }`

### `archive.rs`
```rust
#[derive(Clone)]
pub struct Archive { /* Arc<Mutex<HashSet<String>>> + file path */ }
impl Archive {
    pub async fn load(path: &Path, seed: Vec<String>) -> anyhow::Result<Self>;
    pub async fn contains(&self, key: &str) -> bool;
    pub async fn insert(&self, key: &str) -> anyhow::Result<()>; // adds to set + appends file
}
```
> The archive file path is passed to yt-dlp via `--download-archive`, so yt-dlp and Whale
> share one file. `Archive` is the source of truth for the fast in-memory check; `items` table
> is the durable record. They are seeded from each other on startup (`all_archive_keys`).

### `ytdlp/`
```rust
// metadata.rs
pub async fn probe(cfg: &Config, url: &str) -> Result<Vec<ProbeResult>, YtdlpError>; // Vec for playlists
// download.rs
pub struct DownloadHandle { pub events: mpsc::Receiver<ProgressEvent>, /* .. */ }
pub async fn download(cfg: &Config, item: &Item) -> Result<DownloadOutcome, YtdlpError>;
pub struct DownloadOutcome { pub filepath: String, pub filesize: i64 }
// options.rs
pub fn probe_args(cfg: &Config, url: &str) -> Vec<String>;
pub fn download_args(cfg: &Config, item: &Item) -> Vec<String>;
```

### `queue.rs`
```rust
#[derive(Clone)]
pub struct Queue { /* sender + broadcast handle */ }
impl Queue {
    pub fn spawn(cfg: Config, db: Db, archive: Archive) -> Self; // starts worker(s)
    pub async fn enqueue(&self, item_id: i64);
    pub fn subscribe(&self) -> broadcast::Receiver<ProgressEvent>; // for SSE
}
```

### `api/mod.rs`
```rust
pub struct AppState { pub cfg: Config, pub db: Db, pub archive: Archive, pub queue: Queue }
pub fn router(state: AppState) -> axum::Router;
```

### `seal_import.rs`
```rust
pub struct SealRecord { pub title: String, pub author: Option<String>,
                        pub url: String, pub path: String, pub extractor: String,
                        pub video_id: Option<String> } // parsed from [id] in path, else None
pub struct ImportOutcome { pub imported: u64, pub skipped_dupes: u64, pub unparsable: u64 }
pub async fn run_import(cfg: &Config, db: &Db, archive: &Archive, file: &Path)
    -> anyhow::Result<ImportOutcome>;
```

## 4. Dependency graph (who can be built in parallel)

```
types.rs ──────────────┐  (foundation — build FIRST, then freeze)
config.rs ─────────────┤
                       ▼
   ┌──────────┬────────┼───────────┬──────────────┐
   ▼          ▼        ▼           ▼              ▼
 db/       archive/  ytdlp/     web/ (frontend)  DOCKER/CI
   │          │        │           │              │
   └────┬─────┴───┬────┘           │              │
        ▼         ▼                │              │
      queue.rs   seal_import.rs    │              │
        │         │                │              │
        └────┬────┴────────────────┘              │
             ▼                                     │
          api/  ── serves ──▶ web/                 │
             │                                     │
             ▼                                     │
          main.rs ◀───────────────────────────────┘
```

Parallel-safe groupings are enumerated in [WORKPLAN.md](WORKPLAN.md).

## 5. Crate dependencies (`Cargo.toml` starter)

```toml
[package]
name = "whale"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["full"] }
axum = { version = "0.7", features = ["macros"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["trace", "cors"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "macros", "migrate"] }
anyhow = "1"
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
clap = { version = "4", features = ["derive"] }
rust-embed = "8"
mime_guess = "2"
futures = "0.3"
```
> If the `db` implementer picks `rusqlite`, swap the `sqlx` line for
> `rusqlite = { version = "0.32", features = ["bundled"] }` and wrap calls in `spawn_blocking`.
> This choice is contained to `db/` — no other module changes.
