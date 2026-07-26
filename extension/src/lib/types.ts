// Shared DTOs (mirrors of the Rust `src/types.rs` shapes we consume) and the
// runtime-message protocol between the content script and the userscript shim.

export type Status =
  | 'queued'
  | 'running'
  | 'paused'
  | 'canceled'
  | 'completed'
  | 'failed'
  | 'duplicate';

export interface Item {
  id: number;
  slug: string;
  status: Status;
  url?: string;
  /** The video's canonical page URL, as the server recorded it. This is the key
   *  the content script tracks download state by, so it is what pairs an item
   *  from a batch (whole-playlist) submit back to the thumbnail showing it. */
  webpage_url?: string;
  title?: string | null;
  site_name?: string | null;
  /** Server-computed privacy-blur flag for this item's site (true when the item's
   *  host belongs to a blur-on website, matched across all its related hosts). */
  blur?: boolean;
  /** Recorded upstream thumbnail URL. Non-empty means a preview is available via
   *  the E2EE `/thumb` proxy (fetched + decrypted by the background). */
  thumbnail_url?: string | null;
}

export interface SubmitResult {
  item: Item;
  duplicate: boolean;
  /** Every item created by one source post. X photo posts can expand to several
   *  independent image rows; retaining the full reply keeps progress tracking in
   *  sync with the server instead of pretending only the first image exists. */
  items?: Item[];
}

export interface ProgressEvent {
  id: number;
  status: Status;
  percent: number | null;
  speed: string | null;
  eta: string | null;
  phase?: string | null;
}

export interface CookieStatus {
  present: boolean;
  enabled: boolean;
  bytes: number;
  updated_at: number;
  expires_at?: number | null;
}

export interface Website {
  key: string;
  name: string;
  hosts: string[];
  login_url: string;
  enabled: boolean;
  max_heights: string | null;
  stream_quality: string | null;
  container: string | null;
  subs: boolean | null;
  blur: boolean;
  blur_default: boolean;
  sort: number;
  cookie?: CookieStatus | null;
}

// A user-imported, declarative site adapter (see content/sites.ts) — selectors +
// a URL rule describing how to recognise video thumbnails / permalinks on a site
// the built-in adapters don't cover. Stored raw; validated at use.
export interface UserSiteAdapter {
  id: string;
  hosts: string[];
  thumbSelector?: string;
  queryParam?: string;
  pathRegex?: string;
  canonical?: string;
}

// Persisted config (browser.storage.local).
export interface StoredConfig {
  base: string;
  token: string;
  welcomeDone: boolean;
  features: FeatureFlags;
  /** User-imported site adapters, merged over the built-ins at runtime. */
  siteAdapters: UserSiteAdapter[];
}

export interface FeatureFlags {
  /** Reflect the active download's state machine on the toolbar button icon
   *  (download -> spinner -> progress ring -> cloud-check / X). Default surface. */
  toolbarStatus: boolean;
  /** Inject the cloud-download button onto video pages / posts. */
  inpageButton: boolean;
  /** Website management (the site registry + per-site cookies). */
  websiteManagement: boolean;
}

// Which collection a submitted video was picked from. The in-page button's list
// mode downloads a playlist one video at a time — N ordinary video URLs the
// server can't tell apart from N unrelated submissions — so it names the list
// here and the server records it. That's what lets the web app fold the whole
// list back into a single card. Purely descriptive: it never changes what gets
// fetched. Mirrors the backend's `PlaylistRef`.
export interface PlaylistRef {
  key: string;
  title?: string;
  pos?: number;
}

// ---- Messages: content script -> userscript shim (request) ----

export type BgRequest =
  | { type: 'getConfig' }
  | { type: 'health' }
  | { type: 'submit'; url: string; playlist?: PlaylistRef }
  // Submit a COLLECTION url (a playlist page) and get back every item the server
  // expanded it into — one request, one probe, all rows created together.
  | { type: 'submitList'; url: string }
  | { type: 'itemStatus'; slug: string }
  | { type: 'cancelItem'; slug: string }
  | { type: 'retryItem'; slug: string }
  | { type: 'lookupItem'; url: string; any?: boolean }
  | { type: 'lookupBatch'; urls: string[] }
  | { type: 'setSiteAdapters'; siteAdapters: UserSiteAdapter[] }
  // The site registry — its host list is what licenses permissive video
  // recognition on a page (see content/sites.ts).
  | { type: 'listWebsites' }
  | { type: 'openWebItem'; slug: string };

export type BgResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

// ---- Messages: background -> content (push) ----

export interface ProgressPush {
  type: 'progress';
  event: ProgressEvent;
}
