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
