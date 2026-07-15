-- Every item now carries an unguessable public_slug from creation — not only
-- when it's shared. Owner media URLs (online streaming) are keyed by this slug
-- instead of the sequential item id, so a URL like /api/items/1/stream (which
-- lets anyone trivially enumerate other items by incrementing the id) never
-- appears. The random slug matches random_slug()'s format: 12 bytes → 24 hex.
-- New rows get their slug at insert time; this backfills every existing row.
-- The unique index idx_items_public_slug (migration 0003) still holds.
UPDATE items SET public_slug = lower(hex(randomblob(12))) WHERE public_slug IS NULL;
