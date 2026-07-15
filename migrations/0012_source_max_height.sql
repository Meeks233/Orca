-- Cache the source's maximum available pixel height, discovered once via a
-- yt-dlp probe the first time the user opens an item's resolution picker. Stored
-- so subsequent opens read it straight from the DB instead of re-probing the
-- source every time (the resolution list is otherwise stable for a given video).
-- NULL until first probed.
ALTER TABLE items ADD COLUMN source_max_height INTEGER;
