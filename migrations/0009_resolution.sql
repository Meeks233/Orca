-- Store the downloaded video's pixel height (e.g. 1080, 2160) so the UI can
-- label each item's resolution (720p, 1080p, 4K…). Captured from yt-dlp at
-- download completion via an `after_move:%(height)s` print sidecar. NULL for
-- audio-only downloads, imported records, or anything not yet completed.
ALTER TABLE items ADD COLUMN height INTEGER;
