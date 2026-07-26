// Site adapters — per-platform recognition of video permalinks and thumbnail
// anchors. One adapter answers two questions for the content script:
//
//   1. videoUrl(href): given a candidate link (a thumbnail, a hover-preview's
//      media link, or the page itself), is it a watchable video on this site, and
//      what is its STABLE canonical URL? This drives BOTH the overlay download
//      button's target (so a click on a hover-preview downloads the previewed
//      video, not the search page) and the "already saved" tick recognition.
//   2. thumbSelector: which anchors on the page are video thumbnails worth
//      checking for a tick.
//
// A GENERIC adapter recognises the common video-permalink URL shapes (so most
// sites — bilibili, x/twitter, reddit, vimeo, … — work with no per-site code).
// Explicit built-ins tune the awkward ones (YouTube: query-param ids, a distinct
// hover-preview link, lockup renderers). USER adapters, imported at runtime, add
// or override any site declaratively without a rebuild.

import type { PlaylistRef, UserSiteAdapter } from '../lib/types.js';

export type { UserSiteAdapter };

export interface SiteAdapter {
  id: string;
  /** CSS selector for thumbnail (image) anchors to consider for a tick. Empty =
   *  fall back to the generic image-anchor selector. */
  thumbSelector: string;
  /** Only treat a matched anchor as a video card when it RENDERS at thumbnail
   *  size. The permissive adapter selects every `<a href>` (many video sites build
   *  their cards out of custom elements or CSS backgrounds, so `:has(img)` misses
   *  them), and this is what keeps a text link in the footer from becoming one. */
  requireThumbBox?: boolean;
  /** Canonicalize a candidate href into the stable video URL Orca stores, or null
   *  if it isn't a watchable video on this site. */
  videoUrl(href: string): string | null;
  /** Is this page a collection's OWN page — a playlist, a series — rather than a
   *  page that merely shows several videos (a feed, a search, a watch page with a
   *  sidebar)? Returns the collection's stable key plus a URL the server can
   *  expand into exactly that collection, or null.
   *
   *  The distinction matters twice. It decides whether the downloads get folded
   *  into one card in the web app — and a watch page's recommendations are NOT
   *  part of the playlist it is playing, so tagging them would fold strangers in.
   *  And it decides HOW they are submitted: a collection page can be handed to
   *  the server whole (one probe, all entries at once), where an arbitrary page
   *  has to be submitted a video at a time.
   *
   *  A watch page that carries a `list` param (a playlist or radio mix playing in
   *  the sidebar queue) ALSO counts: its `?list=` queue is a real collection that
   *  can be handed to the server whole. Its recommendation rail is NOT part of
   *  that collection, so `listMemberSelector` scopes the members away from it. */
  playlistPage(href: string): { key: string; url: string } | null;
  /** On a page that PLAYS a list but also shows unrelated videos — a watch page's
   *  `?list=` queue sitting beside its recommendation rail — the CSS selector that
   *  scopes thumbnail anchors to the list's actual members. `null` when the whole
   *  page IS the list (a `/playlist` page) or there is no bounded list at all. This
   *  is what keeps "download all" and "select all in list" from sweeping in the
   *  recommendation rail. */
  listMemberSelector(href: string): string | null;
  /** A social-media thread currently rendered in the page. Unlike a server
   *  expandable playlist, these URLs must be submitted individually, in DOM
   *  order. `null` means this is not a thread detail page. */
  pageList(href: string): { urls: string[]; playlist: PlaylistRef; label: string } | null;
}

// The declarative UserSiteAdapter shape (id, hosts, thumbSelector?, queryParam?,
// pathRegex?, canonical?) lives in lib/types.ts as a shared DTO — see there.

function parseUrl(href: string): URL | null {
  try {
    const u = new URL(href, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function hostMatches(hosts: string[], hostname: string): boolean {
  return hosts.some((h) => {
    const b = h.replace(/^\.+/, '').toLowerCase();
    return !!b && (hostname === b || hostname.endsWith('.' + b));
  });
}

// ---- generic permalink recognition (the no-per-site-code path) ----

// Path shapes that denote a single video/post across the common video & social
// sites. Deliberately anchored to a following id segment so bare section paths
// (/videos, /shorts) don't match.
const VIDEO_PATH_RE =
  /\/(watch|video|videos|v|w|embed|e|shorts|reel|reels|clip|clips|episode|play|media|status|p|tv)\/[^/?#]+/i;

// Canonicalize a generic video permalink: keep origin + path (drop tracking query
// and hash), except the /watch?v= shape whose id lives in the query.
export function genericVideoUrl(href: string): string | null {
  const u = parseUrl(href);
  if (!u) return null;
  const v = u.pathname === '/watch' ? u.searchParams.get('v') : null;
  if (v && /^[\w-]{4,}$/.test(v)) return `${u.origin}/watch?v=${v}`;
  // X / Twitter status posts, including their `/video/…` and `/photo/…` media
  // sub-URLs, canonicalize to the bare post. yt-dlp resolves the post's actual
  // media, and image posts must reach it now that image downloading is supported.
  const status = u.pathname.match(/^(.*?\/status\/\d+)/);
  if (status) {
    return `${u.origin}${status[1]}`;
  }
  if (VIDEO_PATH_RE.test(u.pathname)) {
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  }
  return null;
}

// Anchors that wrap a thumbnail image — the generic "is this a video card" signal.
// `:has()` is supported by current Chrome & Firefox (the only targets here).
const GENERIC_THUMB_SELECTOR = 'a:has(img), a:has(picture), a:has(canvas)';

// No cross-site convention identifies a collection page, so the generic adapter
// never claims one. List mode still runs on such a page — the videos are just
// submitted one at a time and land as ordinary standalone items.
const noPlaylist = (): { key: string; url: string } | null => null;
const noMemberScope = (): string | null => null;
const noPageList = (): { urls: string[]; playlist: PlaylistRef; label: string } | null => null;

const genericAdapter: SiteAdapter = {
  id: 'generic',
  thumbSelector: GENERIC_THUMB_SELECTOR,
  videoUrl: genericVideoUrl,
  playlistPage: noPlaylist,
  listMemberSelector: noMemberScope,
  pageList: noPageList,
};

// ---- permissive recognition (hosts the Orca server is configured for) ----
//
// The generic adapter above only recognises a handful of URL shapes, so on most
// video sites NO thumbnail resolved to a video — which is why the per-page
// controls (the "Select" multi-select toggle, the tick on saved thumbnails) only
// ever appeared on YouTube and X. Their permalinks simply don't look like
// `/video/<id>`: Vimeo files a video at `/1210585745`, Reddit at
// `/r/<sub>/comments/<id>/<slug>`, XVideos at `/video.<id>/<n>/<slug>`, Pornhub
// at `/view_video.php?viewkey=<id>`.
//
// Rather than hand-write an adapter per platform, recognise a CONTENT PERMALINK
// structurally: a same-site link whose path carries an id-like segment (or an
// id-like query param on a script-style path), minus the navigation paths that
// share that shape (a profile, a channel, a tag, a category…).
//
// That heuristic is deliberately loose, so it is only ever used on a host the
// SERVER already lists in its website registry (see resolveAdapter's
// `knownVideoHost`). On an arbitrary website the conservative generic adapter
// still applies, and nothing is mounted where nothing is downloadable.

// Path segments that mark a listing / account / meta page rather than one piece
// of content. Matched whole-segment (so Reddit's `/r/`, YouTube's `/c/` and other
// short section prefixes are untouched) and case-insensitively.
const NON_CONTENT_SEGMENTS = new Set([
  'user', 'users', 'profile', 'profiles', 'channel', 'channels', 'account',
  'tag', 'tags', 'category', 'categories', 'genre', 'genres',
  'search', 'login', 'signin', 'signup', 'register', 'logout',
  'settings', 'preferences', 'about', 'help', 'support', 'contact', 'faq',
  'terms', 'privacy', 'legal', 'dmca', 'sitemap', 'wiki',
  'subscribe', 'subscriptions', 'following', 'followers', 'feed',
  'model', 'models', 'pornstar', 'pornstars', 'member', 'members', 'author',
  'premium', 'upload', 'studio', 'cart', 'checkout', 'notifications', 'messages',
]);

// Query params that carry a video id on script-style paths (`/view_video.php`,
// `/watch.html`) — the shape a path-only rule can never see.
const ID_QUERY_PARAMS = ['v', 'viewkey', 'video_id', 'videoid', 'vid', 'watch', 'post', 'aid', 'bvid'];

// Does this path segment look like an id (rather than a word)? Digits are the
// signal that survives across platforms — `1210585745`, `1v70xbs`, `BV1DAgS6SEqa`,
// `video.opbtthi900a`. A pure word (`documentary`, `staffpicks`) is not content.
function idLike(segment: string): boolean {
  return segment.length >= 2 && /\d/.test(segment);
}

function permissiveVideoUrl(href: string): string | null {
  // The precise shapes win — they canonicalize better (a `/watch?v=` id, an X
  // post stripped of its `/photo/2` suffix) than "keep the whole path" ever could.
  const exact = genericVideoUrl(href);
  if (exact) return exact;

  const u = parseUrl(href);
  if (!u) return null;
  // A video card links to its own site. An off-site link on a video page is an
  // ad, a sponsor, or a share button.
  if (bareHost(u.hostname) !== bareHost(location.hostname)) return null;

  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null; // the site root is not a video
  for (const segment of segments) {
    const s = segment.toLowerCase();
    if (NON_CONTENT_SEGMENTS.has(s)) return null;
    // Vimeo files profiles at `/user251780882` — id-like, but not a video.
    if (/^(user|profile|channel)\d/.test(s) || s.startsWith('@')) return null;
  }

  const path = '/' + segments.join('/');
  if (segments.some(idLike)) return u.origin + path;
  for (const param of ID_QUERY_PARAMS) {
    const value = u.searchParams.get(param);
    // Keep ONLY the id param: the rest of the query is tracking, and carrying it
    // would defeat the server's dedup of a video already saved from another link.
    if (value && /^[\w.-]{4,}$/.test(value)) {
      return `${u.origin}${path}?${param}=${encodeURIComponent(value)}`;
    }
  }
  return null;
}

function bareHost(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

const permissiveAdapter: SiteAdapter = {
  id: 'permissive',
  // Every link, filtered down by `requireThumbBox` + `permissiveVideoUrl`. A card
  // built from a custom element (Reddit's `<shreddit-post>`) or a CSS background
  // has no `<img>` for `:has()` to find, so the selector cannot be the filter.
  thumbSelector: 'a[href]',
  requireThumbBox: true,
  videoUrl: permissiveVideoUrl,
  playlistPage: noPlaylist,
  listMemberSelector: noMemberScope,
  pageList: noPageList,
};

// ---- YouTube (query-param ids, distinct hover-preview link, lockup renderers) ----

function ytCanonical(id: string | null): string | null {
  return id && /^[\w-]{6,}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

function ytVideoUrl(href: string): string | null {
  const u = parseUrl(href);
  if (!u) return null;
  const h = u.hostname;
  if (h === 'youtu.be') return ytCanonical(u.pathname.slice(1).split('/')[0] || null);
  if (!/(^|\.)youtube\.com$/.test(h)) return null;
  if (u.pathname === '/watch') return ytCanonical(u.searchParams.get('v'));
  const m = u.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]+)/);
  return m ? ytCanonical(m[2]!) : null;
}

const youtubeAdapter: SiteAdapter = {
  id: 'youtube',
  // Thumbnail-image anchors across YouTube's renderer generations: classic
  // `<a id="thumbnail">` (search / grid / older panels), the newer
  // `yt-lockup-view-model` design's content-image link (recs rail, mix/playlist),
  // and the vertical Shorts lockup. A Shorts card carries TWO anchors with the same
  // /shorts/<id> href — the poster and the title — so it is matched via `:has(img)`
  // to tick the thumbnail rather than the text (and to survive class churn).
  thumbSelector:
    'a#thumbnail[href], a.ytLockupViewModelContentImage[href], ' +
    'ytm-shorts-lockup-view-model a[href]:has(img)',
  videoUrl: ytVideoUrl,
  // A collection the server can expand whole. Two shapes qualify:
  //   /playlist?list=<id>  — the list's OWN page, every thumbnail is a member.
  //   /watch?…&list=<id>   — a list (or radio mix) playing in the sidebar queue.
  // Both submit the same `/playlist?list=<id>` URL, because a bare watch URL has
  // its `list` param stripped on normalize (downloading one entry must never drag
  // its playlist in) — the playlist-page form is what survives and expands. The
  // watch page ALSO shows a recommendation rail that belongs to no list, so its
  // members are scoped away from it by `listMemberSelector`. The key is namespaced
  // to match what the server derives from yt-dlp's own `playlist_id`, so a list
  // downloaded by this button and the same list pasted into the web app land in
  // ONE card.
  playlistPage(href: string): { key: string; url: string } | null {
    const list = ytListId(href);
    if (!list) return null;
    return { key: `youtube:${list}`, url: `https://www.youtube.com/playlist?list=${list}` };
  },
  // On a watch page the `?list=` queue lives in the playlist panel; the rest of the
  // page is recommendations that are not members. Scope to the panel so a whole-list
  // download never sweeps them in. A `/playlist` page IS the list — no scoping.
  listMemberSelector(href: string): string | null {
    const u = parseUrl(href);
    if (!u || !/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    if (u.pathname !== '/watch' || !ytListId(href)) return null;
    return (
      'ytd-playlist-panel-renderer a#wc-endpoint[href], ' +
      'ytd-playlist-panel-renderer a#thumbnail[href]'
    );
  },
  pageList: noPageList,
};

// The list id a YouTube URL carries, whether it's a playlist page or a watch page
// playing a list — used to recognise both as the same expandable collection.
function ytListId(href: string): string | null {
  const u = parseUrl(href);
  if (!u || !/(^|\.)youtube\.com$/.test(u.hostname)) return null;
  if (u.pathname !== '/playlist' && u.pathname !== '/watch') return null;
  const list = u.searchParams.get('list');
  return list && /^[\w-]{2,}$/.test(list) ? list : null;
}

// ---- X / Twitter thread detail --------------------------------------------
//
// X virtualises its timeline, but its stable accessibility/test hooks have been
// `article[data-testid="tweet"]`, a timestamp link around `time`, and media
// markers such as `tweetPhoto` / `videoPlayer`.  The latter two are deliberately
// only a filter: the status permalink is what we submit, because yt-dlp (and our
// Twitter image plugin) can then fetch every image/video belonging to that post.
// This is the same DOM-first strategy used by established X clippers: it does
// not depend on a private GraphQL operation or a bearer token that X can revoke.
function xStatus(href: string): { url: string; handle: string; id: string } | null {
  const u = parseUrl(href);
  if (!u || !/(^|\.)(x|twitter)\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/([^/?#]+)\/status\/(\d+)/i);
  if (!m) return null;
  return { url: `https://x.com/${m[1]}/status/${m[2]}`, handle: m[1]!, id: m[2]! };
}

function xArticleStatus(article: Element): { url: string; handle: string; id: string } | null {
  // The timestamp link is the article's own permalink. Other /status links in
  // a quote card or reply preview are not the post represented by this article.
  const time = article.querySelector('time');
  const stampLink = time?.closest<HTMLAnchorElement>('a[href]');
  return stampLink ? xStatus(stampLink.href) : null;
}

function xHasMedia(article: Element): boolean {
  return !!article.querySelector(
    '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], video, a[href*="/photo/"], a[href*="/video/"]',
  );
}

function xPageList(href: string): { urls: string[]; playlist: PlaylistRef; label: string } | null {
  const current = xStatus(href);
  if (!current) return null;
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const first = articles.findIndex((article) => xArticleStatus(article)?.id === current.id);
  if (first < 0) return null; // X is still rendering the focused post.

  // The focused post can be a continuation. Capture the complete contiguous
  // same-author run around it so “Save thread” means the same thing from any
  // post in that rendered thread, while the first other author remains a hard
  // reply-conversation boundary.
  let start = first;
  while (start > 0) {
    const previous = xArticleStatus(articles[start - 1]!);
    if (!previous || previous.handle.toLowerCase() !== current.handle.toLowerCase()) break;
    start--;
  }
  let end = first + 1;
  while (end < articles.length) {
    const next = xArticleStatus(articles[end]!);
    if (!next || next.handle.toLowerCase() !== current.handle.toLowerCase()) break;
    end++;
  }

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const article of articles.slice(start, end)) {
    const post = xArticleStatus(article);
    if (!post) continue;
    if (post.handle.toLowerCase() !== current.handle.toLowerCase()) break;
    if (xHasMedia(article) && !seen.has(post.url)) {
      seen.add(post.url);
      urls.push(post.url);
    }
  }
  return {
    urls,
    playlist: {
      key: `x-thread:${xArticleStatus(articles[start]!)?.id ?? current.id}`,
      title: `X thread by @${current.handle}`,
    },
    label: 'Save thread',
  };
}

const xAdapter: SiteAdapter = {
  id: 'x',
  // Avoid treating avatars and link-card artwork as downloadable post media.
  // Per-post controls are attached to the actual photo/video permalink.
  thumbSelector:
    'article[data-testid="tweet"] a[href*="/status/"][href*="/photo/"], ' +
    'article[data-testid="tweet"] a[href*="/status/"][href*="/video/"]',
  videoUrl: genericVideoUrl,
  playlistPage: noPlaylist,
  listMemberSelector: noMemberScope,
  pageList: xPageList,
};

const BUILTINS: { hosts: string[]; adapter: SiteAdapter }[] = [
  { hosts: ['youtube.com', 'youtu.be'], adapter: youtubeAdapter },
  { hosts: ['x.com', 'twitter.com'], adapter: xAdapter },
];

// ---- user adapter compilation ----

function compileUserAdapter(u: UserSiteAdapter): SiteAdapter | null {
  if (!Array.isArray(u.hosts) || u.hosts.length === 0) return null;
  const thumbSelector = u.thumbSelector || GENERIC_THUMB_SELECTOR;
  const build = (id: string | null): string | null => {
    if (!id || !u.canonical) return null;
    return u.canonical.replace('{id}', id);
  };
  let re: RegExp | null = null;
  if (u.pathRegex) {
    try {
      re = new RegExp(u.pathRegex);
    } catch {
      return null; // a bad regex disables the rule rather than throwing at scan time
    }
  }
  const videoUrl = (href: string): string | null => {
    const url = parseUrl(href);
    if (!url) return null;
    // Only claim links on this adapter's own hosts.
    if (!hostMatches(u.hosts, url.hostname)) return null;
    if (u.queryParam) {
      const built = build(url.searchParams.get(u.queryParam));
      if (built) return built;
    }
    if (re) {
      const m = url.pathname.match(re);
      const built = build(m?.[1] ?? null);
      if (built) return built;
    }
    // No explicit rule matched → fall back to the generic shape (scoped to host).
    return genericVideoUrl(href);
  };
  return {
    id: u.id || u.hosts[0]!,
    thumbSelector,
    videoUrl,
    playlistPage: noPlaylist,
    listMemberSelector: noMemberScope,
    pageList: noPageList,
  };
}

// Resolve the adapter for the current host: a user adapter first (users override
// built-ins), then a built-in, else one of the two fallbacks.
//
// `knownVideoHost` says the SERVER's website registry covers this host — i.e. the
// operator has declared it a site Orca downloads from. That is what licenses the
// permissive structural recognition; everywhere else the conservative generic
// adapter keeps Orca's controls off pages that have nothing to download.
export function resolveAdapter(
  hostname: string,
  userAdapters: UserSiteAdapter[],
  knownVideoHost = false,
): SiteAdapter {
  for (const u of userAdapters) {
    if (hostMatches(u.hosts, hostname)) {
      const compiled = compileUserAdapter(u);
      if (compiled) return compiled;
    }
  }
  for (const b of BUILTINS) {
    if (hostMatches(b.hosts, hostname)) return b.adapter;
  }
  return knownVideoHost ? permissiveAdapter : genericAdapter;
}

/** Does the server's website registry cover this host? Mirrors the backend's own
 *  suffix match (`websites::host_matches`) so client and server agree on which
 *  site a page belongs to. */
export function hostInRegistry(hostname: string, registryHosts: string[]): boolean {
  return hostMatches(registryHosts, bareHost(hostname));
}

// Validate + normalize a raw user-adapter list (from JSON import). Drops entries
// that can't compile so one bad row never breaks the rest.
export function sanitizeUserAdapters(raw: unknown): UserSiteAdapter[] {
  if (!Array.isArray(raw)) return [];
  const out: UserSiteAdapter[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const hosts = Array.isArray(o.hosts)
      ? o.hosts.filter((h): h is string => typeof h === 'string' && !!h.trim())
      : [];
    if (hosts.length === 0) continue;
    const a: UserSiteAdapter = { id: String(o.id ?? hosts[0]), hosts };
    if (typeof o.thumbSelector === 'string') a.thumbSelector = o.thumbSelector;
    if (typeof o.queryParam === 'string') a.queryParam = o.queryParam;
    if (typeof o.pathRegex === 'string') a.pathRegex = o.pathRegex;
    if (typeof o.canonical === 'string') a.canonical = o.canonical;
    if (compileUserAdapter(a)) out.push(a);
  }
  return out;
}
