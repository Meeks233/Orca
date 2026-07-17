-- Two related changes to how resolution is chosen.
--
-- 1. `stream_quality` — a share-bandwidth cap, global and per-site. Sharing a
--    link is the one path where a stranger's playback spends the operator's
--    upstream, so it gets its own ceiling independent of what we downloaded:
--    'lowest' (<=360p) | 'lower' (<=480p) | 'higher' (<=1080p) | 'highest'
--    (uncapped). The share route serves the highest downloaded variant at or
--    under the cap. NULL per-site = follow global; the global defaults to
--    'higher' in code, so an unset settings row is not an error.
--
-- 2. `max_heights` — supersedes the single-valued `max_height`. The cap became a
--    *set*: picking {1080, 480} means "download both a 1080p and a 480p copy",
--    which the item_resolutions table (migration 0011) has always been able to
--    hold but the settings UI could never ask for. Stored as a CSV of pixel
--    heights, where '0' means "highest available" and '' (empty) means "download
--    nothing, stream only" — the latter replacing the old 'none' sentinel that
--    the max_height settings row used.
--
-- The old `websites.max_height` column is deliberately left in place rather than
-- dropped: nothing reads it after this migration, and keeping it makes the
-- backfill below reversible if a downgrade is ever needed.
ALTER TABLE websites ADD COLUMN stream_quality TEXT; -- 'lowest'|'lower'|'higher'|'highest'; NULL = follow global
ALTER TABLE websites ADD COLUMN max_heights TEXT;    -- CSV of heights; '0' = highest, '' = no download, NULL = follow global

-- Backfill per-site: a stream-only site becomes the empty set, an explicit cap
-- becomes a one-element set, and everything else stays NULL (follow global).
-- no_download is checked first because it outranked max_height at download time.
UPDATE websites
SET max_heights = CASE
    WHEN no_download = 1 THEN ''
    WHEN max_height IS NOT NULL AND max_height > 0 THEN CAST(max_height AS TEXT)
    ELSE NULL
END;

-- Backfill the global: the old 'none' sentinel meant stream-only, '0' already
-- meant highest, and any other value was a single cap. INSERT OR IGNORE so a
-- re-run can't clobber a max_heights the user has since edited.
INSERT OR IGNORE INTO settings (key, value)
SELECT 'max_heights', CASE WHEN value = 'none' THEN '' ELSE value END
FROM settings WHERE key = 'max_height';
