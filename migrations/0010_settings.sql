-- Generic key/value store for runtime-adjustable settings the UI can change
-- without a restart. Currently holds `max_height` (the cap passed to yt-dlp's
-- format selector). A `WHALE_MAX_HEIGHT` environment variable, when set, takes
-- precedence over any stored value (see Config::max_height / resolve).
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
