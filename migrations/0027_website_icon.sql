-- Favicon harvested from the live site by the userscript, stored as a data URL.
-- Only ever set for a site Orca ships no bundled mark for; NULL means "still
-- falling back to the generic globe".
ALTER TABLE websites ADD COLUMN icon TEXT;
