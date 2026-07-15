# Database & dedup

## 1. Store choice

- **SQLite** single file at `${WHALE_DATA_DIR}/whale.db` (data dir is a Docker volume).
- Alongside it: **`${WHALE_DATA_DIR}/archive.txt`** — the yt-dlp `--download-archive` file,
  also loaded into an in-memory `HashSet<String>` for O(1) dedup.
- At 10k–100k rows SQLite is comfortable; the only hot path (dedup) is served from memory.

## 2. Schema (`migrations/0001_init.sql`)

```sql
CREATE TABLE items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    extractor     TEXT    NOT NULL,                 -- lowercased extractor_key, e.g. "youtube"
    video_id      TEXT    NOT NULL,                 -- yt-dlp id
    archive_key   TEXT    NOT NULL,                 -- "{extractor} {video_id}"  (dedup key)
    title         TEXT    NOT NULL,
    uploader      TEXT,
    webpage_url   TEXT    NOT NULL,
    thumbnail_url TEXT,
    duration      INTEGER,                          -- seconds
    filepath      TEXT,                             -- set when completed
    filesize      INTEGER,                          -- bytes
    source        TEXT    NOT NULL DEFAULT 'download',   -- 'download' | 'seal-import'
    status        TEXT    NOT NULL,                 -- queued|running|completed|failed|duplicate
    error         TEXT,
    created_at    INTEGER NOT NULL,                 -- unix seconds
    completed_at  INTEGER
);

CREATE UNIQUE INDEX idx_items_archive_key ON items(archive_key);
CREATE INDEX        idx_items_status      ON items(status);
CREATE INDEX        idx_items_created     ON items(created_at DESC, id DESC);  -- keyset paging
```

### `migrations/0002_public.sql` + `migrations/0003_public_slug.sql`
```sql
ALTER TABLE items ADD COLUMN public INTEGER NOT NULL DEFAULT 0;  -- 1 = streamable tokenless
ALTER TABLE items ADD COLUMN public_slug TEXT;                   -- random share slug
CREATE UNIQUE INDEX idx_items_public_slug ON items(public_slug) WHERE public_slug IS NOT NULL;
```
`public = 1` enables tokenless streaming via `GET /api/p/:public_slug` (default `0`, private). The
`public_slug` is a random 24-hex-char token. Since `migrations/0015_backfill_slug.sql` **every** item
carries one from creation (not just when shared) — owner media URLs, e.g. the online-playback proxy
`GET /api/stream/:public_slug`, key off the slug so they can't be derived from the sequential `id`.
Sharing an item just flips `public`, reusing the slug it already has. The `/api/items/:id/file` route
always requires a token.

> **Computed, not stored:** the API adds a `local_available` boolean to each item at
> response time (whether `filepath` points at a real file on disk). It has no column.

### `migrations/0004_clients.sql` — self-registered clients
```sql
CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    passphrase_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the client passphrase
    label TEXT, trusted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE client_site_counts (           -- per-extractor submission tally
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    extractor TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (client_id, extractor)
);
```
Clients self-register a passphrase (only its hash is stored) and, once `trusted`, authenticate
like the owner token. `WHALE_CLIENT_TOFU` controls whether new registrations are trusted on sight.

### `migrations/0009_resolution.sql` + `migrations/0010_settings.sql`
```sql
ALTER TABLE items ADD COLUMN height INTEGER;   -- downloaded video pixel height (720, 1080, 2160…)
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- runtime KV store
```
`height` is captured from yt-dlp at completion (`after_move:%(height)s` sidecar) and labels each
item's resolution in the UI; `NULL` for audio-only / not-yet-completed / imported rows. The
`settings` table holds runtime-adjustable values (currently `max_height`, the resolution cap);
`WHALE_MAX_HEIGHT`, when set, overrides the stored value.

### `migrations/0011_item_resolutions.sql` + `migrations/0012_source_max_height.sql`
```sql
CREATE TABLE item_resolutions ( id, item_id REFERENCES items(id) ON DELETE CASCADE,
    height, filepath, filesize, created_at, UNIQUE(item_id, height) );  -- per-item variants
ALTER TABLE items ADD COLUMN source_max_height INTEGER;  -- cached probed source ceiling
```
`item_resolutions` tracks every downloaded resolution version of an item (a 1080p **and** a 720p
copy). The item's own `filepath`/`filesize`/`height` always point at the **highest** downloaded
variant (repointed whenever variants are added/removed), so a card shows the best version it holds.
`source_max_height` (0012) is retained but superseded by `available_heights`.

### `migrations/0013_available_heights.sql`
```sql
ALTER TABLE items ADD COLUMN available_heights TEXT;  -- CSV of distinct source heights, desc
```
`available_heights` caches the distinct pixel heights the source actually offers
(`"2160,1440,1080,720,480,360"`), parsed from the `formats` list of the submit-time probe — the
same enumeration yt-dlp already does to pick the default format. The resolution picker reads this
directly (no lazy re-probe) and a background refresh keeps it current; `NULL` until probed, empty
string means "probed, no per-format heights". Item responses also carry a **computed** (not stored)
`total_filesize` — `SUM(item_resolutions.filesize)` (falling back to `filesize`) — so the size
capsule shows an item's combined footprint across all downloaded versions.

### Optional FTS (phase 2, `migrations/0002_fts.sql`)
```sql
CREATE VIRTUAL TABLE items_fts USING fts5(
    title, uploader, content='items', content_rowid='id'
);
-- triggers to keep items_fts in sync on insert/update/delete of items.
```
List search (`?q=`) uses FTS when present; otherwise falls back to `LIKE`.

## 3. Dedup design

**Dedup key = `archive_key = "{extractor} {video_id}"`** — byte-identical to the line
yt-dlp writes to `--download-archive` (`make_archive_id` = `f'{ie_key.lower()} {id}'`).
This means Whale's dedup set and yt-dlp's archive are the *same namespace*.

Two layers, both authoritative-consistent:
1. **In-memory `HashSet<String>`** (`archive.rs`) — the fast check on submit.
2. **`items.archive_key` UNIQUE index** — durable guard; a racing double-insert fails cleanly.

### Submit-time flow
```
probe(url) -> ProbeResult { extractor, video_id, ... }
key = "{extractor} {video_id}"
if !options.force && archive.contains(key):
    return existing item (find_by_archive_key), duplicate = true   # no download
else:
    insert_probe(...) status=queued            # UNIQUE index also protects here
    enqueue(item.id)
```

### Why not URL-only
`youtu.be/X`, `youtube.com/watch?v=X`, with/without playlist params all map to the same
`extractor:id`, but are different URL strings. `extractor:id` is the correct identity.
**URL fallback** exists only for Seal import (§SEAL_IMPORT.md) when `[id]` can't be parsed
from the old filename — then we normalize the URL and store that as a synthetic key so the
record still shows in history (it just won't perfectly dedup a future re-submit of a variant
URL). This is documented as a known limitation.

### `force` re-download
`options.force = true` bypasses the memory check and also passes `--no-download-archive`
semantics for that run (yt-dlp still won't skip because we don't feed the archive on force —
see DOWNLOAD_PIPELINE.md). The existing row is reused (status back to `queued`); no dup row.

## 4. Startup consistency

On `serve` start:
1. `db.reset_running_to_queued()` — any `running` rows (crash mid-download) → `queued`,
   returns their ids to re-enqueue.
2. `db.all_archive_keys()` → seed `Archive::load(archive_path, seed)`. `Archive::load` unions
   the DB keys with whatever is already in `archive.txt` and rewrites the file if they differ,
   so the two never drift.
3. Re-enqueue the reset ids.

## 5. Timestamps

Store unix seconds (`INTEGER`). The binary uses `std::time::SystemTime` /
`time`/`chrono` to stamp `created_at`/`completed_at`. (Never rely on SQLite `CURRENT_TIMESTAMP`
string format — keep everything integer unix for cheap sorting and cursors.)

## 6. Keyset pagination

`list` sorts by `created_at DESC, id DESC`. Cursor = last seen `id`.
```sql
SELECT * FROM items
WHERE (:status IS NULL OR status = :status)
  AND (:before_id IS NULL OR id < :before_id)
ORDER BY created_at DESC, id DESC
LIMIT :limit;
```
`next_cursor` = the last row's `id` if a full page was returned, else `null`.
