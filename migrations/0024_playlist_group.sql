-- Playlist membership, as distinct from `playlist_index`.
--
-- `playlist_index` (0008) exists for ONE reason: a multi-video post whose entries
-- all share a webpage_url needs `--playlist-items <n>` to fetch the right clip.
-- It is deliberately NULL for a real playlist of distinct videos, because pinning
-- an index there would make the download re-fetch the whole playlist.
--
-- A real list (a YouTube playlist, a channel tab, whatever the client scraped) is
-- a different fact about an item: which collection it came from, what that
-- collection is called, and where in it this video sat. Stored separately so the
-- web UI can fold a whole list into one card without touching download behaviour.
ALTER TABLE items ADD COLUMN playlist_key   TEXT;    -- "<extractor>:<list id>"
ALTER TABLE items ADD COLUMN playlist_title TEXT;
ALTER TABLE items ADD COLUMN playlist_pos   INTEGER; -- 1-based position, display order only

CREATE INDEX idx_items_playlist_key ON items(playlist_key) WHERE playlist_key IS NOT NULL;
