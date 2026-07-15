-- Per-item downloaded resolution variants. An item can now hold several files,
-- one per pixel height (e.g. a 1080p AND a 720p copy of the same video). The
-- item's own `filepath`/`height` still points at its "primary" file (played,
-- streamed, shared); this table tracks every downloaded resolution so the UI can
-- offer a multi-select to add/remove specific versions.
CREATE TABLE item_resolutions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    height     INTEGER NOT NULL,             -- pixel height, e.g. 1080
    filepath   TEXT    NOT NULL,             -- absolute path of this variant's file
    filesize   INTEGER NOT NULL DEFAULT 0,   -- bytes
    created_at INTEGER NOT NULL,
    UNIQUE(item_id, height)
);
CREATE INDEX idx_item_resolutions_item ON item_resolutions(item_id);

-- Backfill: seed the table from the resolution each completed item already has,
-- so existing downloads show their current version as selected from day one.
INSERT OR IGNORE INTO item_resolutions (item_id, height, filepath, filesize, created_at)
SELECT id, height, filepath, COALESCE(filesize, 0), COALESCE(completed_at, created_at)
FROM items
WHERE filepath IS NOT NULL AND height IS NOT NULL;
