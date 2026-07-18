-- Per-site "default blur" baseline. `blur` records what a site's privacy blur is
-- set to *now*; `blur_default` records what it was SEEDED to, so the Website
-- Management list can sort by *deviation from default* rather than by absolute
-- blur state. Without this, the NSFW sites seeded blur-on below would all float to
-- the top of the list as though the user had customised them. Existing rows seed
-- to 0 (their blur was off out of the box), matching migration 0016's default.
ALTER TABLE websites ADD COLUMN blur_default INTEGER NOT NULL DEFAULT 0;

-- Common NSFW video sites, seeded blurred-by-default (blur = blur_default = 1) so
-- their history cards are private out of the box and copied links are recognised
-- by the clipboard grabber (they match an ENABLED registry host). Enabled like the
-- classic sites and fully editable/removable from the UI; yt-dlp ships extractors
-- for all of them. Sort values continue after the classic sites (0014 ended at 13).
INSERT INTO websites (key, name, hosts, login_url, enabled, blur, blur_default, sort) VALUES
  ('pornhub',     'Pornhub',     'pornhub.com,pornhubpremium.com',              'https://www.pornhub.com/login',         1, 1, 1, 14),
  ('xvideos',     'XVideos',     'xvideos.com,xvideos.es,xvideos2.com,xv-ru.com', '',                                    1, 1, 1, 15),
  ('xhamster',    'xHamster',    'xhamster.com,xhamster.desi,xhamster2.com,xhamster3.com', 'https://xhamster.com/login', 1, 1, 1, 16),
  ('xnxx',        'XNXX',        'xnxx.com,xnxx.es,xnxx.health',                '',                                      1, 1, 1, 17),
  ('redtube',     'RedTube',     'redtube.com,redtube.net',                     'https://www.redtube.com/login',         1, 1, 1, 18),
  ('youporn',     'YouPorn',     'youporn.com',                                 'https://www.youporn.com/login',         1, 1, 1, 19),
  ('spankbang',   'SpankBang',   'spankbang.com,spankbang.party',               '',                                      1, 1, 1, 20),
  ('redgifs',     'RedGIFs',     'redgifs.com',                                 'https://www.redgifs.com/signup/login',  1, 1, 1, 21),
  ('eporner',     'EPorner',     'eporner.com',                                 '',                                      1, 1, 1, 22),
  ('motherless',  'Motherless',  'motherless.com',                              'https://motherless.com/login',          1, 1, 1, 23),
  ('beeg',        'Beeg',        'beeg.com',                                    '',                                      1, 1, 1, 24),
  ('rule34video', 'Rule34Video', 'rule34video.com',                             '',                                      1, 1, 1, 25);
