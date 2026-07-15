-- User-editable website registry: what began as the compile-time platform
-- CATALOG (src/platform.rs) is now a DB table so the Website Management window can
-- edit it at runtime — add sites, edit each site's alternate domains/aliases,
-- toggle it on/off, pin a per-site resolution, and merge duplicate auto-imported
-- sites. `hosts` is a comma-separated list of registrable domain suffixes (the
-- "other domains" seed list the UI lets you extend); a URL matches a site when its
-- host equals or is a subdomain of any listed suffix. The static CATALOG stays as
-- the seed + code-side fallback for alias search folding.
CREATE TABLE websites (
    key        TEXT PRIMARY KEY,           -- canonical, filesystem-safe id (also cookie file stem)
    name       TEXT NOT NULL,              -- human label for the UI
    hosts      TEXT NOT NULL DEFAULT '',   -- comma-separated domain suffixes / aliases
    login_url  TEXT NOT NULL DEFAULT '',   -- page to open when capturing cookies
    enabled    INTEGER NOT NULL DEFAULT 1, -- 0 = disabled (submissions from this site are refused)
    max_height INTEGER,                    -- per-site resolution cap; NULL = follow global setting
    no_download INTEGER NOT NULL DEFAULT 0,-- 1 = stream-only default for this site (no local files)
    sort       INTEGER NOT NULL DEFAULT 0, -- display order
    created_at INTEGER NOT NULL DEFAULT 0
);

-- Seed the classic video sites with their gathered alternate domains (dedup lives
-- in the app layer on every save). These are editable/removable from the UI.
INSERT INTO websites (key, name, hosts, login_url, sort) VALUES
  ('youtube',     'YouTube',     'youtube.com,youtu.be,youtube-nocookie.com,youtubekids.com', 'https://accounts.google.com/ServiceLogin?service=youtube', 1),
  ('twitter',     'X / Twitter', 'x.com,twitter.com,t.co,fxtwitter.com,vxtwitter.com,fixupx.com', 'https://x.com/login', 2),
  ('instagram',   'Instagram',   'instagram.com,instagr.am,ig.me,ddinstagram.com', 'https://www.instagram.com/accounts/login/', 3),
  ('facebook',    'Facebook',    'facebook.com,fb.watch,fb.com,fb.me', 'https://www.facebook.com/login/', 4),
  ('tiktok',      'TikTok',      'tiktok.com,vm.tiktok.com,vt.tiktok.com', 'https://www.tiktok.com/login', 5),
  ('bilibili',    'Bilibili',    'bilibili.com,b23.tv,bilibili.tv,acg.tv,b22.tv', 'https://passport.bilibili.com/login', 6),
  ('reddit',      'Reddit',      'reddit.com,redd.it', 'https://www.reddit.com/login/', 7),
  ('twitch',      'Twitch',      'twitch.tv', 'https://www.twitch.tv/login', 8),
  ('vimeo',       'Vimeo',       'vimeo.com', 'https://vimeo.com/log_in', 9),
  ('niconico',    'Niconico',    'nicovideo.jp,nico.ms', 'https://account.nicovideo.jp/login', 10),
  ('weibo',       'Weibo',       'weibo.com,weibo.cn,t.cn', 'https://passport.weibo.com/', 11),
  ('soundcloud',  'SoundCloud',  'soundcloud.com,snd.sc', 'https://soundcloud.com/signin', 12),
  ('dailymotion', 'Dailymotion', 'dailymotion.com,dai.ly', 'https://www.dailymotion.com/signin', 13);
