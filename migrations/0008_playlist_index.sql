-- Multi-video posts (e.g. an X/Twitter tweet with two clips) probe into several
-- entries that all share ONE webpage_url. Downloading such an item by its URL
-- alone re-fetches the whole post and the --download-archive dedup then breaks
-- the sibling. We disambiguate by storing the entry's position within the post
-- and passing `--playlist-items <n>` on download/stream so each item fetches
-- only its own video. NULL means a standalone item (the common case) — no
-- position needed.
ALTER TABLE items ADD COLUMN playlist_index INTEGER;
