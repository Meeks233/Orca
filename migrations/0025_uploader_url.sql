-- The uploader's own page (channel / profile URL), so the web app can turn the
-- uploader name on a card into a link back to who posted it.
--
-- `uploader` (0001) is just the display name; this is the address. yt-dlp reports
-- it as `uploader_url`, falling back to `channel_url` for sites that only name the
-- channel. NULL for rows downloaded before this column existed and for sources
-- that report neither.
ALTER TABLE items ADD COLUMN uploader_url TEXT;
