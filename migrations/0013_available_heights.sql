-- Cache the distinct video pixel heights the source actually offers (e.g.
-- "2160,1440,1080,720,480,360"), captured from yt-dlp's format list at probe
-- time — the same format enumeration yt-dlp already does to pick the best
-- format for a default download, so no extra work is needed up front. The
-- resolution picker reads this straight from the DB (no lazy re-probe), and a
-- background refresh keeps it current. NULL until first probed; empty string
-- means "probed but the source reported no per-format heights".
ALTER TABLE items ADD COLUMN available_heights TEXT;
