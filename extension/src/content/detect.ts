// Content script: find the right spot on a video page/post, mount the cloud
// download button, and run its lifecycle (download -> spinner -> ring ->
// cloud-check / X) off the background's progress pushes. All crypto/API lives in
// the background; this script only touches the DOM and messages.

import { glyphSvg, type GlyphName } from '../lib/glyphs.js';
import { isPrivateHost } from '../lib/net.js';
import { ringPercentForPhase } from '../lib/progress.js';
import type {
  BgResponse,
  Item,
  PlaylistRef,
  ProgressEvent,
  Status,
  SubmitResult,
} from '../lib/types.js';
import {
  hostInRegistry,
  resolveAdapter,
  sanitizeUserAdapters,
  type SiteAdapter,
  type UserSiteAdapter,
} from './sites.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// `submitting` and `queued` look similar but mean opposite things about who is
// waiting on whom. `submitting` is OUR request in flight — the server hasn't
// answered yet, so a spinner is honest. `queued` is the server's answer: the item
// is accepted and parked behind the downloads ahead of it. Nothing is happening
// to it, possibly for many minutes, so it gets a STILL clock instead. Spinning
// forty-five spinners for one running download was the "everything is loading
// forever" effect this splits apart.
type State = 'idle' | 'submitting' | 'queued' | 'progress' | 'success' | 'error' | 'canceled';

// The download state machine, once per canonical video URL — see DownloadState.
const track = new Map<string, DownloadState>(); // canonical url -> state
const byItem = new Map<number, DownloadState>(); // itemId -> state
const decorated = new WeakSet<Element>();
// Mounted overlay buttons paired with their <video>. SPA sites (YouTube) reuse
// the same <video> element across navigations, so a rescan won't remount the
// button — we re-check these against the new URL when the location changes.
const mounted: { btn: OrcaButton; video: Element; lastUrl: string }[] = [];
// Hold the live progress ring just under full; a full ring is reserved for a
// real completion, so an in-flight download never reads as "done" (yt-dlp
// reports per-stream percent that hits 100 at the end of each stream).
const RUNNING_RING_MAX = 95;
// Ring fill below which the arc has nothing to say: a couple of degrees swallowed
// by its own round line-caps, painting a stationary dot that looks identical for
// seconds on end. Under this the spinner stands in — see OrcaButton.render.
const RING_VISIBLE_MIN = 0.04;
// Server statuses that mean the download has stopped for good — the server has
// spoken, so these are never suppressed by a pending cancel (see `canceling`).
const TERMINAL = new Set<Status>(['completed', 'duplicate', 'canceled', 'failed']);
let backendOnline = false;
const liveButtons = new Set<OrcaButton>();

async function refreshBackendHealth(): Promise<void> {
  let online = false;
  try {
    online = (await send<{ online: boolean }>({ type: 'health' })).online;
  } catch { /* disconnected */ }
  if (online === backendOnline) return;
  backendOnline = online;
  for (const button of liveButtons) button.renderCurrent();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Reveal an overlay button in lock-step with the native player controls: it
// appears while the pointer is anywhere over the video, fades a beat after the
// pointer leaves the player (like the controls do), and fades after a longer
// idle while the pointer rests on the player. Tracking the in/out transition —
// not just "seen a move here" — is what stops the button lingering in the corner
// after the controls have gone. One rAF-throttled document listener drives them.
interface OverlayReveal {
  rect: () => DOMRect;
  el: HTMLElement;
  inside: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}
const overlayReveals: OverlayReveal[] = [];
const CONTROLS_IDLE_MS = 2600; // resting on the player: match the native idle-hide
const CONTROLS_LEAVE_MS = 600; // pointer left the player: fade out with the controls
// One-shot discoverability hint: flash the FIRST button that mounts on a page so
// a new user learns it exists, then it settles back to hover-only reveal.
let hintShown = false;

function revealShow(o: OverlayReveal): void {
  o.el.classList.add('orca-visible');
  if (o.leaveTimer) {
    clearTimeout(o.leaveTimer);
    o.leaveTimer = null;
  }
  if (o.idleTimer) clearTimeout(o.idleTimer);
  o.idleTimer = setTimeout(() => o.el.classList.remove('orca-visible'), CONTROLS_IDLE_MS);
}
function revealHideSoon(o: OverlayReveal): void {
  if (o.leaveTimer) return;
  if (o.idleTimer) {
    clearTimeout(o.idleTimer);
    o.idleTimer = null;
  }
  o.leaveTimer = setTimeout(() => {
    o.leaveTimer = null;
    o.el.classList.remove('orca-visible');
  }, CONTROLS_LEAVE_MS);
}

let revealListenerInstalled = false;
function installRevealListener(): void {
  if (revealListenerInstalled) return;
  revealListenerInstalled = true;
  let pending = false;
  let x = 0;
  let y = 0;
  const tick = (): void => {
    pending = false;
    for (const o of overlayReveals) {
      const r = o.rect();
      const nowInside =
        r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      if (nowInside) {
        o.inside = true;
        revealShow(o);
      } else if (o.inside) {
        o.inside = false;
        revealHideSoon(o);
      }
    }
  };
  document.addEventListener(
    'pointermove',
    (e) => {
      x = e.clientX;
      y = e.clientY;
      if (pending) return;
      pending = true;
      requestAnimationFrame(tick);
    },
    { passive: true },
  );
  // Pointer left the document entirely (no more moves will fire): fade all out.
  document.addEventListener(
    'pointerleave',
    () => {
      for (const o of overlayReveals)
        if (o.inside) {
          o.inside = false;
          revealHideSoon(o);
        }
    },
    { passive: true },
  );
}

async function send<T>(msg: unknown): Promise<T> {
  const resp = (await browser.runtime.sendMessage(msg)) as BgResponse<T>;
  if (!resp.ok) {
    const e = new Error(resp.error) as Error & { status?: number };
    e.status = resp.status;
    throw e;
  }
  return resp.data;
}

// One video can be shown by SEVERAL buttons at the same time: the one pinned onto
// its thumbnail once a download starts, and the transient one that remounts on the
// site's shared hover-preview player right after (promoteButton releases the video
// so hovering still works). They must never disagree — when each button owned its
// own state machine, cancelling from one and re-downloading from the other left the
// other stuck on a stale glyph (a dead "retry" over a live download, a spinner that
// never stopped).
//
// So the state machine lives HERE, exactly once per canonical video URL, and a
// button is only a VIEW of it: every click mutates this state, and the state
// re-renders all of its views. Two layers can't drift apart because there is only
// ever one state to drift.
class DownloadState {
  readonly url: string;
  state: State = 'idle';
  itemId: number | null = null;
  slug: string | null = null;
  completed = false;
  // Ring fill 0..1, and the "silent postprocessing" sweep flag — see advanceFrac.
  frac = 0;
  finalizing = false;
  // Tooltip for a submit/retry that failed outright (no item to retry).
  errorMsg: string | null = null;
  private views = new Set<OrcaButton>();
  private revertTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  // The server has already been asked what it knows about this URL (see
  // checkExisting) — every later view attaching to the same video reuses the answer
  // instead of re-querying.
  private lookedUp = false;
  // Whether a `video` phase frame has been seen this download, so a later `audio`
  // frame is mapped as the tail of a two-stream job (see advanceFrac).
  private sawVideoPhase = false;
  // The user asked to cancel and the server hasn't confirmed it yet. Two things
  // made a cancel need clicking twice, and this latch fixes both: a cancel clicked
  // before the submit response lands (no slug yet) is REMEMBERED and fired the
  // moment the item exists, and the `running` updates still in flight at that
  // moment — a queued push, or a poll that was already awaiting its answer — are
  // ignored instead of flipping the button back to a live ring.
  private canceling = false;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  // A source post may expand into several server items (notably X photo posts).
  // Keep their terminal truth together: one post button must not turn green when
  // its first image lands while the remaining images are still queued.
  private memberStatuses = new Map<number, Status>();
  // The poll fallback must cover the same complete set as SSE. Without these
  // slugs, a quiet/reconnected event stream polls only the first expanded item
  // and can still paint the post as finished while later videos are running.
  private memberSlugs = new Map<number, string>();

  private constructor(url: string) {
    this.url = url;
  }

  static for(url: string): DownloadState {
    let s = track.get(url);
    if (!s) {
      s = new DownloadState(url);
      track.set(url, s);
    }
    return s;
  }

  // Which list this video is being downloaded as part of, when the whole-page
  // button started it. Rides along on the submit so the server can record it and
  // the web app can fold the list into one card. Null for a lone download.
  private playlist: PlaylistRef | null = null;

  // `lookup` asks the server what it already knows about this URL. A thumbnail
  // button passes false: a grid of them would fire one request per row, and the
  // thumbnail scan's single BATCHED lookup answers for all of them at once.
  attach(view: OrcaButton, lookup = true): void {
    this.views.add(view);
    view.render(this);
    if (lookup) void this.checkExisting();
  }

  // The batched thumbnail lookup says this video is already in the library. Adopt
  // that verdict as if a per-URL lookup had returned it — minus the item id/slug,
  // which the batch doesn't carry and `activate` resolves only if it's clicked.
  seedCompleted(): void {
    if (this.state !== 'idle' || this.completed) return;
    this.lookedUp = true;
    this.completed = true;
    this.setFrac(100);
    this.setState('success');
  }

  // Live in the server's eyes: our submit is in flight, the item is parked in the
  // queue, or it is actually downloading. All three mean "a click stops this" and
  // "don't start it again" — only the reason for the wait differs.
  get busy(): boolean {
    return this.state === 'submitting' || this.state === 'queued' || this.state === 'progress';
  }

  // Start this video as part of a whole-list download. Anything already in flight,
  // or already saved, is left alone — the list button is "fetch what's missing",
  // not "start everything over". Returns whether it actually kicked something off.
  startInList(playlist: PlaylistRef | null): boolean {
    if (this.canceling) return false;
    if (this.busy || this.completed) return false;
    this.playlist = playlist;
    // A known failed/canceled item must go through /retry — a plain submit of one
    // is deduped by the server and would silently do nothing.
    if (this.slug && (this.state === 'canceled' || this.state === 'error')) {
      void this.retryDownload();
    } else {
      void this.submitDownload();
    }
    return true;
  }

  // Progress of this one video as a 0..1 contribution to a list's aggregate.
  get listFrac(): number {
    if (this.completed || this.state === 'success') return 1;
    return this.state === 'progress' ? this.frac : 0;
  }

  // Stop this video as part of a whole-list cancel. Only touches what is still
  // live — an already-finished download is not undone by cancelling the list.
  cancelInList(): void {
    if (this.busy && !this.canceling) void this.cancelDownload();
  }

  // A batch submit covering this video is in flight. It has no item of its own
  // yet — the single request is still probing the whole list — so it shows the
  // still "waiting" clock. A page of spinners would be the wrong picture twice
  // over: nothing is downloading, and only ONE request is actually outstanding.
  markQueuedForList(): void {
    if (this.busy || this.completed) return;
    this.setState('queued');
  }

  // That batch failed. Anything it parked has nothing coming, so let it fall back
  // to the plain download glyph rather than waiting on a queue it never joined.
  releaseQueuedForList(): void {
    if (this.state === 'queued' && !this.slug) this.setState('idle');
  }

  // Adopt an item the server created for this URL as part of a BATCH submit (the
  // whole playlist in one request), where the response arrives as a list rather
  // than as this state's own submit reply.
  adoptFromBatch(item: Item): void {
    if (this.completed) return;
    this.adoptItem(item, item.status === 'duplicate');
  }

  // Re-run an entry the batch submit could not start. A submit of a URL the
  // server ALREADY has is deduplicated — it answers with the existing row and
  // changes nothing — so a playlist containing videos that were previously
  // cancelled or failed comes back with those still parked, and "download all"
  // silently skipped exactly the ones the user was most likely retrying for.
  // Only /retry actually re-queues them.
  retryInList(): void {
    if (this.completed || this.busy || !this.slug) return;
    void this.retryDownload();
  }

  // This video's part in the list run is over, one way or another. A failure
  // counts: it has stopped, its own button is showing the retry glyph, and the
  // list pill must be able to finish rather than hang at 97% forever.
  get listSettled(): boolean {
    return this.state === 'success' || this.state === 'error' || this.state === 'canceled';
  }

  detach(view: OrcaButton): void {
    this.views.delete(view);
    this.disposeIfDone();
  }

  // Forget a state nobody is showing any more. An in-flight download is KEPT even
  // with no views — its poll has to keep running so that hovering the thumbnail
  // again picks the live ring back up, and so the finished download still paints
  // its "saved" tick.
  private disposeIfDone(): void {
    if (this.views.size) return;
    if (this.busy) return;
    if (this.revertTimer) clearTimeout(this.revertTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.revertTimer = this.stallTimer = this.cancelTimer = null;
    if (track.get(this.url) === this) track.delete(this.url);
    if (this.itemId != null && byItem.get(this.itemId) === this) byItem.delete(this.itemId);
    for (const id of this.memberStatuses.keys()) {
      if (byItem.get(id) === this) byItem.delete(id);
    }
  }

  // Repaint every button showing this video. Copied because a view can detach
  // itself while rendering (a pinned button retires on success).
  private emit(): void {
    for (const v of [...this.views]) v.render(this);
  }

  private setState(s: State): void {
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.state = s;
    // Leaving the live ring (or re-entering the spinner) clears any "finalizing"
    // sweep — only an at-the-cap progress frame re-arms it (see advanceFrac).
    if (s !== 'progress') this.finalizing = false;
    if (s !== 'error') this.errorMsg = null;
    // Only the transient (no-item) submit failure clears itself back to idle; a
    // tracked failed/canceled item stays parked on retry until the user acts.
    if (s === 'error' && !this.slug) {
      this.revertTimer = setTimeout(() => {
        this.revertTimer = null;
        if (this.state === 'error') this.setState('idle');
      }, 2600);
    }
    // While a download is live, poll the backend for its real progress. This is
    // the AUTHORITATIVE sync — the pushed SSE frames are only a fast path. If a
    // push is dropped, the SSE stream drops, the background page suspends, or the
    // tab is backgrounded, the ring would otherwise freeze at its last frame
    // (commonly a full ring reading "100%" that never finishes). Every push
    // re-arms this timer, so a healthy push stream means it rarely fires; the
    // moment pushes go quiet it takes over and keeps the ring tracking the real
    // download, and it settles the button into its true end state.
    if (s === 'submitting' || s === 'queued' || s === 'progress') this.armPoll();
    this.emit();
    // Painted only after the views have rendered: the pinned button retires itself
    // on success, and paintTick defers while a live button occupies the thumbnail.
    if (s === 'success') markDownloaded(this.url);
    this.disposeIfDone();
  }

  private setFrac(percent: number | null): void {
    if (percent == null) this.sawVideoPhase = false; // fresh download — forget the phase
    this.frac = percent == null ? 0 : Math.max(0, Math.min(1, percent / 100));
    this.emit();
  }

  // Live download progress that only ever moves forward. yt-dlp reports per-STREAM
  // percent: a `bv*+ba` download runs the video stream 0→100 then the audio stream
  // 0→100. Mapping each phase onto its own contiguous band (video → [0,85], audio →
  // [85,95]) turns the two passes into one honest, monotonic climb that keeps
  // advancing through the audio phase instead of freezing at the cap the instant
  // the video stream finishes. Held just shy of full (RUNNING_RING_MAX) so only a
  // real completion fills the ring.
  private advanceFrac(percent: number, phase?: string | null): void {
    if (phase === 'video') this.sawVideoPhase = true;
    const target = ringPercentForPhase(percent, phase, this.sawVideoPhase, RUNNING_RING_MAX);
    // At the running cap the transfer is essentially done and only yt-dlp's SILENT
    // postprocessing remains (merge + embed subs/thumbnail/metadata) — it emits no
    // more download frames, so the ring would otherwise sit frozen at 95% for the
    // whole finalize (the "stuck at 95%" report). Flag it so the ring sweeps a
    // "finalizing" spin instead of reading as dead.
    if (target >= RUNNING_RING_MAX) this.finalizing = true;
    if (target / 100 > this.frac) this.setFrac(target);
    else this.emit();
  }

  private armPoll(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => void this.syncProgress(), 2500);
  }

  private async syncProgress(): Promise<void> {
    this.stallTimer = null;
    if (!this.busy) return;
    if (!this.slug) return;
    try {
      if (this.memberStatuses.size > 1) {
        const results = await Promise.allSettled(
          [...this.memberSlugs.entries()].map(async ([id, slug]) => {
            const { item } = await send<{ item: Item }>({ type: 'itemStatus', slug });
            return { id, status: item.status };
          }),
        );
        // A failed poll for one member must not hide fresh terminal truth from
        // the others. The next normal poll retries only the one that failed.
        for (const result of results) {
          if (result.status === 'fulfilled')
            this.memberStatuses.set(result.value.id, result.value.status);
        }
        this.refreshMultiState();
        return;
      }
      const { item } = await send<{
        item: Item & { progress?: { percent: number | null; phase?: string | null } };
      }>({
        type: 'itemStatus',
        slug: this.slug,
      });
      // This answer was asked for BEFORE the click and describes the download as it
      // was then — adopting it would resurrect the ring the cancel just dismissed.
      if (this.canceling && !TERMINAL.has(item.status)) return;
      if (TERMINAL.has(item.status)) this.canceling = false;
      if (item.status === 'completed' || item.status === 'duplicate') {
        this.completed = true;
        this.setFrac(100);
        this.setState('success');
        return;
      }
      if (item.status === 'canceled') {
        this.setState('canceled');
        return;
      }
      if (item.status === 'failed') {
        this.setState('error');
        return;
      }
      // Still working: reflect the server's live percent (capped so a per-stream
      // 100 never misreads as done), then keep polling.
      const pct = item.progress?.percent;
      if (pct != null && item.status === 'running') {
        this.setState('progress');
        this.advanceFrac(pct, item.progress?.phase);
      } else if (item.status === 'queued' || item.status === 'paused') {
        this.setState('queued');
      }
      this.armPoll();
    } catch {
      this.armPoll();
    }
  }

  // A click on ANY button showing this video. One control whose meaning depends on
  // the state — the whole download state machine funnels through here:
  //   in-flight (submitting/progress) → CANCEL the download (hover shows the X)
  //   finished (success)              → PLAY the saved copy in the web app
  //   parked terminal with an item    → RETRY it (/retry re-queues; a plain submit
  //                                      would be deduped by the server and do nothing)
  //   idle / no item                  → fresh SUBMIT
  async activate(): Promise<void> {
    // A cancel is already on its way. The extra clicks that follow one are
    // impatience, not a request to start over — without this they would land on the
    // freshly parked retry glyph and re-launch the download the user just stopped.
    if (this.canceling) return;
    if (this.busy) return this.cancelDownload();
    if (this.completed) {
      // A state seeded from the BATCH lookup knows the video is saved but not
      // under which slug — that answer costs a request, so it's only fetched now
      // that someone has actually asked to play it.
      if (this.slug) await send({ type: 'openWebItem', slug: this.slug });
      else await openSavedVideo(this.url);
      return;
    }
    if (this.slug && (this.state === 'canceled' || this.state === 'error'))
      return this.retryDownload();
    return this.submitDownload();
  }

  // Fresh submit (idle → in-flight).
  private async submitDownload(): Promise<void> {
    if (this.itemId != null) byItem.delete(this.itemId);
    this.itemId = null;
    this.slug = null;
    this.memberStatuses.clear();
    this.memberSlugs.clear();
    this.completed = false;
    this.canceling = false; // a fresh download supersedes any pending cancel
    this.setFrac(null);
    this.setState('submitting');
    try {
      const res = await send<SubmitResult>({
        type: 'submit',
        url: this.url,
        tabWatch: true,
        ...(this.playlist ? { playlist: this.playlist } : {}),
      });
      const items = res.items?.length ? res.items : [res.item];
      if (items.length > 1) {
        this.memberStatuses = new Map(items.map((item) => [item.id, item.status]));
        this.memberSlugs = new Map(items.map((item) => [item.id, item.slug]));
        for (const item of items) byItem.set(item.id, this);
      }
      this.adoptItem(items[0]!, res.duplicate);
    } catch (e) {
      this.errorMsg = (e as Error).message || 'Submit failed';
      this.setState('error');
    }
  }

  // Re-run an already-recorded failed/canceled item. Goes through /retry (not a
  // fresh submit, which the server dedups) so a download the user canceled or that
  // failed actually starts over.
  private async retryDownload(): Promise<void> {
    if (!this.slug) return this.submitDownload();
    const slug = this.slug;
    this.completed = false;
    this.canceling = false; // retrying supersedes the cancel that parked this item
    this.setFrac(null);
    this.setState('submitting');
    try {
      const { item } = await send<{ item: Item }>({ type: 'retryItem', slug, tabWatch: true });
      this.itemId = item.id;
      this.slug = item.slug;
      byItem.set(item.id, this);
      // Stay 'submitting' until progress pushes / the poll drive it forward.
    } catch (e) {
      this.errorMsg = (e as Error).message || 'Retry failed';
      this.setState('error');
    }
  }

  // Cancel the in-flight download. Park on retry immediately — a cancel has to LOOK
  // like it landed on the first click — and hold that appearance (see `canceling`)
  // until the server agrees. While the submit is still in flight there is no item to
  // cancel yet, so the intent is recorded and adoptItem fires it the instant one
  // exists, instead of the click doing nothing at all.
  private async cancelDownload(): Promise<void> {
    this.canceling = true;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
    this.setState('canceled');
    if (!this.slug) return;
    try {
      await send({ type: 'cancelItem', slug: this.slug });
      // The server writes the canceled status before killing yt-dlp, so the only
      // updates still coming are stragglers. Stop suppressing after they've drained,
      // so a lost final event can't leave the button permanently unclickable.
      this.cancelTimer = setTimeout(() => {
        this.cancelTimer = null;
        this.canceling = false;
      }, 5000);
    } catch {
      // The request never landed, so stop suppressing the server's updates and let
      // the true state (probably still running) show through again.
      this.canceling = false;
    }
  }

  // Fold a submit/lookup result item into the tracked state.
  private adoptItem(item: Item, duplicate = false): void {
    this.itemId = item.id;
    this.slug = item.slug;
    byItem.set(item.id, this);
    // The group map is installed before its representative item is adopted. Do
    // not briefly publish that representative's terminal state: a completed
    // first video must not retire this post's SVG while its siblings run.
    if (this.memberStatuses.size > 1 && this.memberStatuses.has(item.id)) {
      if (this.canceling && !TERMINAL.has(item.status)) void this.cancelDownload();
      this.refreshMultiState();
      return;
    }
    // A cancel clicked while this submit was still in flight now has something to
    // act on — honour it rather than starting to show progress the user has
    // already said they don't want.
    if (this.canceling && !TERMINAL.has(item.status)) {
      void this.cancelDownload();
      return;
    }
    this.canceling = false;
    if (item.status === 'completed' || (duplicate && item.status === 'duplicate')) {
      this.completed = true;
      this.setFrac(100);
      this.setState('success');
    } else if (item.status === 'canceled') {
      this.setState('canceled');
    } else if (item.status === 'failed') {
      this.setState('error');
    } else if (item.status === 'running') {
      this.setState('progress');
    } else {
      // queued / paused — accepted by the server but not started. Parked, not
      // working, so it shows the still clock rather than a spinner; the poll
      // (armed by setState) tracks it until it starts.
      this.setState('queued');
    }
  }

  // Ask the server for this URL's latest item in ANY state (any=true) so the button
  // starts on the control that matches reality: the green tick for an already-saved
  // video, a retry glyph for one canceled/failed on another client, or the live ring
  // for one still downloading — not a plain download glyph that, clicked, would be
  // deduped and rejected. Runs once per video, however many buttons show it.
  private async checkExisting(): Promise<void> {
    if (this.lookedUp || this.state !== 'idle') return;
    this.lookedUp = true;
    try {
      const { item } = await send<{ item: Item | null }>({
        type: 'lookupItem',
        url: this.url,
        any: true,
      });
      if (item && this.state === 'idle') this.adoptItem(item, item.status === 'duplicate');
    } catch {
      this.lookedUp = false; // offline / not configured — leave idle, a later mount retries
    }
  }

  onProgress(ev: ProgressEvent): void {
    if (this.memberStatuses.size > 1 && this.memberStatuses.has(ev.id)) {
      this.memberStatuses.set(ev.id, ev.status);
      this.refreshMultiState();
      return;
    }
    // A cancel is pending: the download keeps reporting for a beat while the server
    // kills yt-dlp. Showing those frames would put the ring back and make the cancel
    // read as a missed click.
    if (this.canceling && !TERMINAL.has(ev.status)) return;
    if (TERMINAL.has(ev.status)) this.canceling = false;
    if (ev.status === 'running' && ev.percent != null) {
      this.setState('progress');
      this.advanceFrac(ev.percent, ev.phase);
    } else if (ev.status === 'queued' || ev.status === 'paused') {
      this.setState('queued');
    } else if (ev.status === 'completed' || ev.status === 'duplicate') {
      this.completed = true;
      this.setFrac(100);
      this.setState('success');
    } else if (ev.status === 'canceled') {
      this.setState('canceled');
    } else if (ev.status === 'failed') {
      this.setState('error');
    }
  }

  private refreshMultiState(): void {
    const statuses = [...this.memberStatuses.values()];
    if (!statuses.length) return;
    const success = (s: Status): boolean => s === 'completed' || s === 'duplicate';
    if (statuses.every(success)) {
      this.completed = true;
      this.setFrac(100);
      this.setState('success');
      return;
    }
    if (statuses.every((s) => TERMINAL.has(s))) {
      this.setState(statuses.some((s) => s === 'failed') ? 'error' : 'canceled');
      return;
    }
    if (statuses.some((s) => s === 'running')) this.setState('progress');
    else this.setState('queued');
  }
}

// The bare DOM of a download control: the pill, its spinner, its progress ring
// and its hover-to-cancel X. Shared by the per-video button (OrcaButton) and the
// whole-list button (ListButton) so both wear the same lifecycle chrome and are
// driven by the same `data-state` / `--orca-frac` CSS — one control, two scopes.
function buildButtonShell(): { el: HTMLButtonElement; glyphWrap: HTMLElement } {
  const el = document.createElement('button');
  el.className = 'orca-dl-btn';
  el.type = 'button';
  el.title = 'Download with Orca';
  el.setAttribute('aria-label', 'Download with Orca');
  el.dataset.state = 'idle';
  const glyphWrap = document.createElement('span');
  glyphWrap.className = 'orca-dl-glyph-wrap';
  // CSS border spinner (its own element) — replaces the rotating SVG stroke,
  // whose anti-aliased line-caps shimmered ("noise") while spinning.
  const spinner = document.createElement('span');
  spinner.className = 'orca-dl-spinner';
  el.appendChild(spinner);
  const ring = document.createElementNS(SVG_NS, 'svg');
  ring.setAttribute('class', 'orca-dl-ring');
  ring.setAttribute('viewBox', '0 0 24 24');
  ring.setAttribute('aria-hidden', 'true');
  for (const c of ['orca-dl-track', 'orca-dl-arc']) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('class', c);
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');
    ring.appendChild(circle);
  }
  el.appendChild(glyphWrap);
  el.appendChild(ring);
  // Hover-reveal cancel affordance: while a download is in flight, hovering the
  // button surfaces this X over the spinner/ring so a click stops the download
  // (the mature download-manager gesture — progress ring that turns into a stop
  // on hover). Hidden otherwise; CSS shows it only on :hover of an active state.
  const cancelWrap = document.createElement('span');
  cancelWrap.className = 'orca-dl-cancel';
  cancelWrap.appendChild(glyphSvg('x'));
  el.appendChild(cancelWrap);
  return { el, glyphWrap };
}

// A button is a VIEW of the DownloadState for whatever video it currently covers.
// It owns no download state of its own — it renders what it is told and forwards
// clicks — so every button on a video (thumbnail-pinned + hover-preview) always
// shows the same thing.
class OrcaButton {
  readonly el: HTMLButtonElement;
  private glyphEl: HTMLElement;
  private glyph: GlyphName | null = null;
  private st: DownloadState;
  // Live URL resolver. On a feed/search page this points at the site's SHARED
  // hover-preview player, so it deliberately re-resolves to whatever is being
  // previewed right now — that's what lets one idle button serve every thumbnail.
  // Dropped once the button is pinned to a single thumbnail (see bindUrl).
  private resolveUrl: (() => string) | null;
  // Mounted directly on a thumbnail rather than on a player. Such a button IS
  // that row's status light — it never gets promoted anywhere (it is already
  // where a promotion would put it) and never retires on success.
  private readonly thumb: boolean;

  constructor(url: string, resolveUrl?: () => string, thumb = false) {
    this.resolveUrl = resolveUrl ?? null;
    this.thumb = thumb;
    const { el, glyphWrap } = buildButtonShell();
    if (thumb) el.classList.add('orca-thumb-btn');
    this.glyphEl = glyphWrap;
    this.setGlyph('cloudDownload');
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.onClick();
    });
    // Fully isolate the overlay from the player underneath. Stopping only `click`
    // still lets the earlier `pointerdown` / `mousedown` reach the host player:
    // YouTube's player listens for a press on the video surface, so a press that
    // lands on this button can trigger a stray play/pause/seek — which reads as
    // the playing video glitching or erroring the moment you hit download.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
    this.el = el;
    liveButtons.add(this);
    this.st = DownloadState.for(url);
    // A thumbnail button never asks the server about its own video: a grid of them
    // would fire one lookup per row. Their answer arrives instead from the single
    // batched lookup the thumbnail scan already runs (see pumpThumbQueue).
    this.st.attach(this, !thumb);
  }

  private setGlyph(name: GlyphName): void {
    if (this.glyph === name) return; // renders run per progress frame — don't churn the DOM
    this.glyph = name;
    this.glyphEl.replaceChildren(glyphSvg(name));
  }

  // Paint whatever the shared state currently says. The ONLY place this button's
  // appearance is decided, so a thumbnail-pinned button and a hover-preview button
  // on the same video can never show different things.
  render(st: DownloadState): void {
    if (st !== this.st) return; // a stale state we've since detached from
    if (!backendOnline && !st.busy) {
      this.el.dataset.state = 'offline';
      this.el.disabled = true;
      this.el.style.color = 'var(--orca-offline, #f59e0b)';
      this.el.title = 'Orca server is offline — downloads are unavailable';
      this.setGlyph('globeOff');
      return;
    }
    this.el.disabled = false;
    this.el.style.color = '';
    const s = st.state;
    // An in-flight download whose ring has no legible arc yet paints as a bare
    // grey circle: `progress` hides the glyph in favour of the ring, and a ring at
    // ~0 draws a stationary dot. On a BIG video the first few percent take many
    // seconds, so the control sits there completely motionless — and a button that
    // looks dead reads as one that can't be clicked (it can: it cancels). Fall back
    // to the SPINNER for that window. Same in-flight control, just honest that the
    // transfer has started and has nothing to show yet — the ring takes over the
    // moment it has an arc worth drawing. This also covers a running download
    // adopted from a lookup, whose percent only arrives with the first poll.
    const pending = s === 'submitting' || (s === 'progress' && st.frac < RING_VISIBLE_MIN);
    this.el.dataset.state = pending ? 'submitting' : s;
    if (s === 'progress' && st.finalizing) this.el.dataset.finalizing = '1';
    else delete this.el.dataset.finalizing;
    this.el.style.setProperty('--orca-frac', String(st.frac));
    if (pending) this.setGlyph('loader');
    else if (s === 'idle') this.setGlyph('cloudDownload');
    else if (s === 'queued') this.setGlyph('clock');
    else if (s === 'progress') this.setGlyph('cloudDownload');
    else if (s === 'success') this.setGlyph('cloudCheck');
    else if (s === 'canceled') this.setGlyph('retry');
    // `error` is two situations wearing one state: a server-side FAILED item we're
    // tracking (has a slug → retry glyph, parked, click re-runs it via /retry), and
    // a transient submit failure with no item (no slug → the X, which clears back to
    // idle so a fresh submit can be tried). A plain re-submit of a failed item is
    // deduped by the server and does nothing, so a known item must go through retry.
    else if (s === 'error') this.setGlyph(st.slug ? 'retry' : 'x');
    // Tooltip reflects what a click does in each state (in-flight → cancel; a
    // parked terminal → retry). Hover on an in-flight button reveals the cancel X.
    this.el.title =
      s === 'queued'
        ? 'Waiting in the download queue — click to cancel'
        : s === 'submitting' || s === 'progress'
        ? 'Cancel download'
        : s === 'error' && st.errorMsg
          ? st.errorMsg
          : s === 'canceled'
            ? 'Download canceled — click to retry'
            : s === 'error' && st.slug
              ? 'Download failed — click to retry'
              : s === 'success'
                ? 'Play in Orca'
                : 'Download with Orca';
  }

  private onClick(): void {
    // An offline control must never start/retry a job. Keep cancellation available
    // for a job that was already accepted, though: it cannot create a new submit.
    if (!backendOnline && !this.st.busy) return;
    // The shared preview player may have switched videos since the last scan —
    // re-point at what is under the pointer NOW, so the click can't act on the
    // previously previewed video.
    this.syncUrl();
    void this.st.activate();
  }

  // Re-point this button at the video it currently covers. Called on every scan and
  // SPA navigation: feed/search pages reuse ONE shared <video> for every thumbnail,
  // so the element never changes while the video it plays does. Re-attaching hands
  // the button the new video's state — an already-saved next video shows its check,
  // a fresh one drops back to the download glyph, and a download still running on
  // the PREVIOUS video keeps its own state (its thumbnail button shows the ring).
  syncUrl(): void {
    if (!this.resolveUrl) return;
    const url = this.resolveUrl();
    if (url === this.st.url) return;
    this.st.detach(this);
    this.st = DownloadState.for(url);
    this.st.attach(this, !this.thumb);
  }

  // This button is gone (its <video> left the page): stop being a view of its
  // state, so nothing keeps the dead button — or the state — alive.
  dispose(): void {
    liveButtons.delete(this);
    this.st.detach(this);
  }

  renderCurrent(): void { this.render(this.st); }
}

// ---- mounting ----

// Where to hang a video's overlay. Normally the video's own parent — but a parent
// that establishes a STACKING CONTEXT traps the button inside it: our z-index then
// only orders us against that parent's own children, and nothing can lift us over
// the parent's SIBLINGS. YouTube's watch player does exactly this.
// `.html5-video-container` is `position:relative; z-index:10`, and the player
// chrome (`.ytp-chrome-top`, z-index 58) is a sibling of it — a bar that spans the
// full width of the player's top edge, right where this button sits. So the button
// was painted and, worse, HIT-TESTED underneath it, and every click went to
// YouTube: the control only worked in the moments the chrome happened to be
// auto-hidden. Hanging the overlay one level up makes it a sibling of the chrome,
// where its own z-index finally counts. Only done when that parent really is a
// trap, and only while the box stays put, so the button can't wander off the video.
function overlayHost(video: Element): HTMLElement | null {
  const parent = video.parentElement;
  if (!parent?.parentElement) return parent;
  const cs = getComputedStyle(parent);
  if (cs.position === 'static' || cs.zIndex === 'auto') return parent;
  const up = parent.parentElement;
  const a = parent.getBoundingClientRect();
  const b = up.getBoundingClientRect();
  return Math.abs(a.left - b.left) <= 1 && Math.abs(a.top - b.top) <= 1 ? up : parent;
}

function mountVideoOverlays(): void {
  const videos = Array.from(document.querySelectorAll('video'));
  for (const v of videos) {
    if (decorated.has(v)) continue;
    const rect = v.getBoundingClientRect();
    if (rect.width < 220 || rect.height < 120) continue;
    // A hover preview over a thumbnail that already carries this video's button —
    // one control per video, and the thumbnail's is the one that survives the
    // pointer leaving. Deliberately not marked `decorated`: the same element is
    // reused as a real player elsewhere, so the check is re-run rather than latched.
    if (coversThumbButton(v)) continue;
    const host = overlayHost(v);
    if (!host) continue;
    decorated.add(v);
    // Anchor the button in a positioned wrapper over the video's top-LEFT,
    // aligned with YouTube's own top-left overlay affordances (the "More from"
    // channel chip lives there) rather than fighting the top-right controls.
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:absolute;top:8px;left:8px;z-index:2147483000;pointer-events:auto';
    const url = resolveVideoUrl(v);
    const btn = new OrcaButton(url, () => resolveVideoUrl(v));
    mounted.push({ btn, video: v, lastUrl: url });
    wrap.appendChild(btn.el);
    // Ensure the host can position the overlay.
    const pos = getComputedStyle(host).position;
    if (pos === 'static') host.style.position = 'relative';
    host.appendChild(wrap);
    // Track the native player controls: reveal whenever the pointer is over the
    // video and fade out once it leaves, so the button appears/disappears with
    // the controls instead of hogging the corner. (Active downloads force
    // themselves visible via CSS.)
    const reveal: OverlayReveal = {
      // The HOST's box, not the <video>'s. They are normally the same, but a
      // player can lay the video out somewhere else entirely: YouTube's watch
      // player gives `.html5-video-container` zero height and places the video at
      // `top:-655px` inside it, so the element's viewport rect sits ABOVE the
      // player it fills. Hovering the player therefore never matched, and the
      // button stayed invisible for the whole session after its one-shot mount
      // hint. The host box is the player area the user actually points at.
      rect: () => host.getBoundingClientRect(),
      el: btn.el,
      inside: false,
      idleTimer: null,
      leaveTimer: null,
    };
    overlayReveals.push(reveal);
    installRevealListener();
    // First-mount hint: flash the first button visible for a beat (reusing the
    // reveal's own idle-hide timing) so a new user sees it, then it returns to
    // appearing only on hover. A live download still forces itself visible via CSS.
    if (!hintShown) {
      hintShown = true;
      revealShow(reveal);
    }
  }
}

// ---- video thumbnails: a download control on every one ----
//
// Every video thumbnail across a site — search results, the recommendations rail,
// playlist rows, the home/subscriptions grid — links to its own video, so every
// one of them gets its OWN button: idle on hover, the live progress ring while it
// downloads, the green check once it's saved. That's the same control the overlay
// button is, and (crucially) a VIEW OF THE SAME STATE: a download started from a
// watch page's player paints its ring on that video's thumbnail in the sidebar
// too, and the whole-list button below drives every row at once by simply
// starting each row's own state.
//
// WHICH anchors count as thumbnails, and HOW to turn a link into the stable video
// URL Orca stores, both come from the active SiteAdapter (see ./sites.ts). So the
// same code covers YouTube (query-param ids, lockup renderers), the generic
// video-permalink sites (bilibili, x, reddit, vimeo, …) recognised by URL shape,
// and any user-imported platform — no per-site branches here.
//
// Recognition is NON-BURSTY and CHEAP: unresolved URLs drain through a queue that
// resolves a whole BATCH per sealed request (one round-trip for a grid, not one
// lookup per row — see DownloadState.attach). Results cache by canonical URL, so
// recycling rows as you scroll repaints from cache instead of re-asking.
let adapter: SiteAdapter = resolveAdapter(location.hostname, []);

// X wraps each photo in `/status/<id>/photo/<n>`. Keep it as the post URL rather
// than peeling out the visible CDN thumbnail: our yt-dlp plugin resolves the
// original rendition with the user's X cookies, and retains the post id, author
// and text for Orca's social-post card.
function anchorUrl(anchor: HTMLAnchorElement): string | null {
  return adapter.videoUrl(anchor.href);
}
const THUMB_BATCH_MAX = 200; // urls per sealed lookup (server caps at 256)
const THUMB_BATCH_INTERVAL = 200; // ms between batches — unhurried, rarely reached
const thumbResult = new Map<string, boolean>(); // canonicalUrl -> downloaded?
const thumbQueued = new Set<string>(); // urls already awaiting a verdict
const thumbQueue: string[] = [];
let thumbPumping = false;
// The button mounted on each thumbnail anchor. Weak so a row the site recycles
// out of the DOM takes its button with it.
const thumbBtns = new WeakMap<HTMLElement, OrcaButton>();

// Open the saved copy of a video in the Orca web app. A state seeded from the
// BATCH check knows the video is saved but not under which slug (the batch
// answers "downloaded?", nothing more), so resolve it on demand — one lookup,
// and only when someone actually clicks.
async function openSavedVideo(url: string): Promise<void> {
  if (!url) return;
  try {
    const { item } = await send<{ item: Item | null }>({ type: 'lookupItem', url });
    if (item?.slug) await send({ type: 'openWebItem', slug: item.slug });
  } catch {
    /* offline / not configured — nothing to open */
  }
}

// Give a thumbnail its download control, or re-point the one it already has at
// the video it now shows (feed rows are recycled: the anchor survives, its href
// changes). The button hangs in its own positioned wrapper so nothing about the
// site's own layout inside the <a> has to be disturbed.
function mountThumbButton(anchor: HTMLAnchorElement, url: string): void {
  const existing = thumbBtns.get(anchor);
  if (existing) {
    // The site re-rendered this row's insides and swept our wrapper away with it.
    // Let go of the orphan (so it stops being a view of its state) and re-mount.
    if (existing.el.isConnected) {
      existing.syncUrl();
      return;
    }
    existing.dispose();
    thumbBtns.delete(anchor);
  }
  const btn = new OrcaButton(url, () => anchorUrl(anchor) ?? url, true);
  const wrap = document.createElement('div');
  wrap.className = 'orca-thumb-wrap';
  wrap.appendChild(btn.el);
  if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
  anchor.appendChild(wrap);
  thumbBtns.set(anchor, btn);
}

// Drain the lookup queue a BATCH at a time, resolving up to THUMB_BATCH_MAX URLs
// in a single sealed request and spacing batches by THUMB_BATCH_INTERVAL. Each
// URL is resolved once; the verdict goes to the URL's shared DownloadState, which
// repaints every button showing that video.
async function pumpThumbQueue(): Promise<void> {
  if (thumbPumping) return;
  thumbPumping = true;
  while (thumbQueue.length) {
    // Peel off a batch of still-unresolved URLs.
    const batch: string[] = [];
    while (thumbQueue.length && batch.length < THUMB_BATCH_MAX) {
      const url = thumbQueue.shift()!;
      if (!thumbResult.has(url)) batch.push(url);
    }
    if (batch.length) {
      try {
        const { downloaded } = await send<{ downloaded: string[] }>({
          type: 'lookupBatch',
          urls: batch,
        });
        const saved = new Set(downloaded);
        for (const url of batch) thumbResult.set(url, saved.has(url));
        for (const url of saved) DownloadState.for(url).seedCompleted();
      } catch {
        // Offline / not configured — leave uncached and let a later scan retry.
        for (const url of batch) thumbQueued.delete(url);
      }
    }
    if (thumbQueue.length) await sleep(THUMB_BATCH_INTERVAL);
  }
  thumbPumping = false;
}

function scanThumbs(): void {
  for (const a of thumbAnchors()) {
    const url = anchorUrl(a);
    if (!url) continue;
    mountThumbButton(a, url);
    if (a.dataset.orcaThumb === url) continue;
    a.dataset.orcaThumb = url;
    if (thumbResult.get(url) === true) {
      DownloadState.for(url).seedCompleted();
    } else if (!thumbResult.has(url) && !thumbQueued.has(url)) {
      thumbQueued.add(url);
      thumbQueue.push(url);
    }
    // Known-not-downloaded: the button is already sitting on its idle glyph.
  }
  if (thumbQueue.length) void pumpThumbQueue();
}

// An anchor has to RENDER at least this big to pass as a video card. Sized to the
// smallest real thumbnail tile (a sidebar rec, a mobile row) while excluding text
// links, breadcrumbs and icon buttons — see SiteAdapter.requireThumbBox.
const MIN_THUMB_W = 96;
const MIN_THUMB_H = 54;

function isThumbSized(anchor: HTMLAnchorElement): boolean {
  const r = anchor.getBoundingClientRect();
  return r.width >= MIN_THUMB_W && r.height >= MIN_THUMB_H;
}

function thumbAnchors(): HTMLAnchorElement[] {
  if (!adapter.thumbSelector) return [];
  try {
    const picked: HTMLAnchorElement[] = [];
    for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>(adapter.thumbSelector))) {
      const url = anchorUrl(anchor);
      if (!url) continue;
      if (adapter.requireThumbBox && !isThumbSized(anchor)) continue;
      // X (and several SPA social sites) places a photo link and its containing
      // post link over the very same image. Both normalize to one post URL, so
      // mounting both produces two SVG controls that truthfully share state but
      // visibly duplicate one another. Keep one only when they cover the same
      // visual tile; separate photos in a carousel retain their own controls.
      const duplicate = picked.some((other) => {
        if (anchorUrl(other) !== url) return false;
        if (other.contains(anchor) || anchor.contains(other)) return true;
        const a = anchor.getBoundingClientRect();
        const b = other.getBoundingClientRect();
        return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
          && overlapRatio(a, b) > 0.88;
      });
      if (!duplicate) picked.push(anchor);
    }
    return picked;
  } catch {
    return []; // a malformed user selector must not break anything
  }
}

// Remember that a just-finished download is saved, so a rescan (or a row recycled
// back into view) reads the verdict from cache instead of re-asking the server.
// The buttons themselves need no prodding — they are views of the state that just
// reached `success` and have already repainted.
function markDownloaded(url: string): void {
  if (!url) return;
  thumbResult.set(url, true);
}

// Fraction of the SMALLER rect that the two share. Used to pair a hover-preview
// player with the thumbnail it is covering.
function overlapRatio(a: DOMRect, b: DOMRect): number {
  const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (ix <= 0 || iy <= 0) return 0;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? (ix * iy) / smaller : 0;
}

// Is this <video> a hover preview lying on top of a thumbnail that already has
// its own button? Matched by GEOMETRY rather than DOM ancestry on purpose: sites
// commonly mount the hover preview as a GLOBAL overlay element (YouTube's
// `ytd-video-preview` lives outside the result card entirely) that merely
// positions itself over the thumbnail.
//
// Such a player must NOT get its own overlay button: the thumbnail underneath is
// already showing this exact video's control, in the same corner, and the two
// would sit on top of each other. The thumbnail's button is the better of the
// two anyway — it's stable, where the preview player is torn down the moment the
// pointer leaves.
function coversThumbButton(video: Element): boolean {
  const vr = video.getBoundingClientRect();
  if (vr.width < 1 || vr.height < 1) return false;
  for (const a of thumbAnchors()) {
    if (!thumbBtns.has(a)) continue;
    if (overlapRatio(vr, a.getBoundingClientRect()) > 0.6) return true;
  }
  return false;
}

// Resolve the canonical video URL for a mounted <video>. The nearest surrounding
// link the adapter recognises as a video is what makes a click on a HOVER PREVIEW
// download the previewed video (its media link sits just above the <video>) rather
// than the search/feed page. Falling back to the enclosing post's permalink covers
// x/reddit (the link is a timestamp anchor beside the media, not wrapping it); the
// page URL itself covers a watch page's own primary player.
function resolveVideoUrl(el: Element): string {
  let node: Element | null = el;
  for (let i = 0; i < 10 && node; i++) {
    const a = node.closest('a[href]') as HTMLAnchorElement | null;
    if (!a) break;
    const u = adapter.videoUrl(a.href);
    if (u) return u;
    node = a.parentElement;
  }
  const container = el.closest(
    'article, [role="article"], [data-testid="tweet"], [data-testid="cellInnerDiv"], shreddit-post, .tweet',
  );
  if (container) {
    for (const link of Array.from(container.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
      const u = adapter.videoUrl(link.href);
      if (u) return u;
    }
  }
  return adapter.videoUrl(location.href) ?? location.href;
}

let features = { inpageButton: true };

// A shared hover-preview player is reused for EVERY thumbnail on a feed/search
// page: the same <video> element silently becomes a different video as the pointer
// moves, with no navigation to react to. A button left sitting on it keeps showing
// the PREVIOUS video's state — which is why, after one download finished, hovering
// any other thumbnail showed that download's green check. Detect the identity
// change and re-point the button at the new video's state. A download running on
// the video it just left is untouched — that state lives on independently and its
// pinned button keeps showing the ring.
function syncMountedIdentity(): void {
  for (const m of mounted) {
    if (!m.video.isConnected) continue;
    const url = resolveVideoUrl(m.video);
    if (url === m.lastUrl) continue;
    m.lastUrl = url;
    m.btn.syncUrl();
  }
}

// ---- list mode: one button that downloads every video on the page ----
//
// A page that shows many videos at once — a YouTube playlist, a channel's videos
// tab, a search — is a download job the per-video buttons make tediously manual.
// This is the whole-page control: it sits in a fixed corner pill, says how many
// videos it can see, and on click starts each one THROUGH ITS OWN DownloadState.
// So the list button isn't a parallel download path at all — every row's own
// thumbnail button lights up, rings and finishes exactly as if it had been
// clicked by hand, and the pill above them just reports the aggregate.
//
// How they are submitted depends on the page. A COLLECTION page (adapter
// .playlistPage — YouTube's /playlist?list=…) is handed to the server whole: one
// request, one probe, every row created together, and the server names the
// collection from yt-dlp's own playlist metadata so the web app folds them into
// one card. Any other page (a search, a feed) has no such url, so its videos go
// one at a time and land as ordinary standalone items.
//
// Mid-run the pill stops being a button and becomes a progress report — with one
// exception: clicking it cancels the entire list, which is the only place that
// gesture exists (per-video cancel only ever stops one).
const LIST_MIN = 3; // fewer videos than this isn't a list, it's a page with a video on it
const LIST_CONCURRENCY = 3; // submits in flight at once — each one costs the server a probe
const LIST_ARM_MS = 4000; // how long the pill waits for the confirming second click

// The one control that reports a list run: the bottom-right FAB pill. The
// player's top-left corner deliberately does NOT host a second view of it — that
// spot belongs to the CURRENTLY PLAYING video's own button, so it agrees with the
// tick on that video's row in the queue panel beside it. A whole-list control up
// there meant the playing video's saved state was shown in the sidebar and
// nowhere else, and that a watch page reached from a list showed "download all"
// where its own download button belongs.
interface ListView {
  btn: HTMLButtonElement;
  glyph: HTMLElement;
  label: HTMLElement;
  wrap: HTMLElement;
}
let fabView: ListView | null = null; // bottom-right "Download all" pill
function listViews(): ListView[] {
  return fabView ? [fabView] : [];
}
// The run in progress: the videos it started, so the pill can report their
// combined progress. Null when nothing has been launched from this page.
let listRun: {
  urls: string[];
  /** URLs the run has already kicked off — the rest are still queued behind
   *  LIST_CONCURRENCY and have no DownloadState to report yet. */
  started: Set<string>;
  timer: ReturnType<typeof setInterval> | null;
  /** Social threads are submitted in reading order, one request at a time. */
  sequential: boolean;
  /** Descriptive grouping recorded on each individually submitted thread post. */
  playlist: PlaylistRef | null;
  label: string;
} | null = null;
// The pill is waiting for its confirming second click — see armList.
let listArmed = false;
let listArmTimer: ReturnType<typeof setTimeout> | null = null;
// A whole-list submit that failed outright — shown on the pill until it clears.
let listError: string | null = null;

// The thumbnail anchors that count as MEMBERS of this page's list. On a watch page
// the adapter scopes them to the `?list=` queue panel so "download all" never
// sweeps in the recommendation rail beside it; everywhere else every thumbnail on
// the page is a member.
function listMemberAnchors(): HTMLAnchorElement[] {
  const sel = adapter.listMemberSelector(location.href);
  if (!sel) return thumbAnchors();
  try {
    // The panel may not be rendered yet — an empty result is honest ("no members
    // seen"), never a fallback to the whole page (which would re-include recs).
    return Array.from(document.querySelectorAll<HTMLAnchorElement>(sel));
  } catch {
    return [];
  }
}

// Distinct member videos of this page's list, in order — what "download all" runs.
function pageList(): { urls: string[]; playlist: PlaylistRef; label: string } | null {
  return adapter.pageList(location.href);
}

function listUrls(): string[] {
  // X threads are article-based rather than thumbnail grids. The adapter owns
  // their media-only filtering and reading order; ordinary pages retain the
  // generic thumbnail path.
  return pageList()?.urls ?? distinctUrls(listMemberAnchors());
}

// Distinct videos across EVERY thumbnail on the page (recs included), in order —
// what multi-select's "All" offers and what shift-range selection indexes into.
function listAllUrls(): string[] {
  return distinctUrls(thumbAnchors());
}

function distinctUrls(anchors: HTMLAnchorElement[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of anchors) {
    const url = anchorUrl(a);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

// Build the list-run control (shared shell + ring + hover-to-cancel X), wired to
// start/cancel the whole list on click.
function buildListView(): ListView {
  const { el, glyphWrap } = buildButtonShell();
  el.classList.add('orca-list-btn');
  glyphWrap.replaceChildren(glyphSvg('cloudDownload'));
  const label = document.createElement('span');
  label.className = 'orca-list-label';
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void runList();
  });
  return { btn: el, glyph: glyphWrap, label, wrap: el };
}

// Maintain the bottom-right UI: the "Download all" pill (only where the page is a
// real collection the server can expand — a /playlist page or a watch page's
// ?list= queue — never a bare feed of recommendations), and the multi-select
// "Select" toggle (wherever the page shows a gridful of videos).
function ensureListButton(): void {
  const collection = !!adapter.playlistPage(location.href);
  const socialList = pageList();
  const total = listUrls().length;
  // A thread may have only one media post but is still a meaningful "save this
  // thread" action. Other pages need a gridful before offering a global control.
  const showFab = (collection && total >= LIST_MIN) || (!!socialList && total > 0);
  if (showFab && !fabView) {
    fabView = buildListView();
    const wrap = document.createElement('div');
    wrap.className = 'orca-list-fab';
    wrap.append(fabView.btn, fabView.label);
    fabView.wrap = wrap;
    fabStack().appendChild(wrap);
  } else if (!showFab && fabView && !listRun) {
    // Navigated away from a collection (SPA) — but never yank the pill out from
    // under a run still reporting progress.
    fabView.wrap.remove();
    fabView = null;
  }
  ensureSelectToggle();
  positionFabStack();
  // Paint whatever views exist (the FAB, the player overlay, or both).
  if (listViews().length && !listArmed) renderListButton(total);
}

// Paint the pill: idle it offers the count, mid-run it becomes the same progress
// ring the per-video buttons wear, driven by the same `data-state` / `--orca-frac`
// contract (see buildButtonShell).
function renderListButton(total: number): void {
  const views = listViews();
  if (!views.length) return;
  if (listArmed) return; // mid-confirmation: armList owns the label until it resolves
  if (!listRun) {
    const label = pageList()?.label ?? 'Download all';
    for (const v of views) {
      v.btn.dataset.state = listError ? 'error' : 'idle';
      v.btn.style.setProperty('--orca-frac', '0');
      v.glyph.replaceChildren(glyphSvg('cloudDownload'));
      v.label.textContent = listError ?? `${label} · ${total}`;
      v.btn.title = listError ?? `${label} ${total} media posts with Orca`;
      v.btn.setAttribute('aria-label', listError ?? `${label} ${total} media posts with Orca`);
    }
    return;
  }
  const n = listRun.urls.length;
  // Only videos this run has actually reached are asked how they are doing. The
  // rest are still queued behind LIST_CONCURRENCY and have no state yet — reading
  // them as "no state, so finished" would declare the whole run over on its very
  // first tick.
  const states = listRun.urls
    .filter((u) => listRun!.started.has(u))
    // A state that has been disposed (finished, and its row scrolled out of view)
    // is gone from `track` — it can only have left by settling, so count it done.
    .map((u) => track.get(u) ?? null);
  const saved = states.filter((s) => !s || s.listFrac >= 1).length;
  const settled = states.filter((s) => !s || s.listSettled).length;
  const failed = states.filter((s) => s && s.listSettled && s.listFrac < 1).length;
  const frac = states.reduce((sum, s) => sum + (s ? s.listFrac : 1), 0) / n;
  const over = listRun.started.size === n && settled === n;
  for (const v of views) {
    v.btn.dataset.state = over ? (failed ? 'error' : 'success') : 'progress';
    v.btn.style.setProperty('--orca-frac', String(frac));
    v.glyph.replaceChildren(glyphSvg(over && !failed ? 'cloudCheck' : 'cloudDownload'));
    v.label.textContent = over && failed ? `${saved} / ${n} · ${failed} failed` : `${saved} / ${n}`;
    v.btn.title = over
      ? `Downloaded ${saved} of ${n}`
      : `${listRun.label} in progress — click to cancel all ${n}`;
    v.btn.setAttribute(
      'aria-label',
      over ? `Downloaded ${saved} of ${n}` : `Cancel ${listRun.label.toLowerCase()} (${n} media posts)`,
    );
  }
  // Finished: hand the pill back to its idle offer, so a list that has since
  // grown (an infinite feed scrolled further) can be run again. The failures are
  // left on their own rows' buttons, where a click retries just that one.
  if (over) {
    if (listRun.timer) clearInterval(listRun.timer);
    listRun = null;
    setTimeout(() => renderListButton(listUrls().length), 2600);
  }
}

// Starting dozens of downloads deserves a confirmation, but NOT a native
// `confirm()`: a blocking modal thrown over the page by an extension is jarring,
// and it is exactly the dialog browsers increasingly suppress. The pill confirms
// itself instead — the first click arms it ("Download 12 videos?"), a second
// within LIST_ARM_MS commits, and silence disarms it. The gesture stays where the
// user is already looking.
function armList(): void {
  const views = listViews();
  if (!views.length) return;
  if (listArmTimer) clearTimeout(listArmTimer);
  listArmed = true;
  listError = null;
  const n = listUrls().length;
  const label = pageList()?.label ?? 'Download all';
  for (const v of views) {
    v.btn.classList.add('orca-list-armed');
    v.label.textContent = `${label} · ${n}?`;
    v.btn.title = `Click again to ${label.toLowerCase()} ${n} media posts`;
  }
  listArmTimer = setTimeout(() => {
    listArmTimer = null;
    listArmed = false;
    for (const v of listViews()) v.btn.classList.remove('orca-list-armed');
    renderListButton(listUrls().length);
  }, LIST_ARM_MS);
}

function disarmList(): void {
  if (listArmTimer) clearTimeout(listArmTimer);
  listArmTimer = null;
  listArmed = false;
  for (const v of listViews()) v.btn.classList.remove('orca-list-armed');
}

// Stop the whole run. Only what is still live is touched — videos that already
// finished are not un-downloaded by changing your mind about the rest — and the
// pill drops straight back to its idle offer rather than waiting for every
// cancel to be acknowledged, because a stop must LOOK like it landed at once.
function cancelList(): void {
  const run = listRun;
  if (!run) return;
  if (run.timer) clearInterval(run.timer);
  listRun = null;
  for (const url of run.urls) track.get(url)?.cancelInList();
  renderListButton(listUrls().length);
}

// Hand the whole collection to the server in ONE request and let it enumerate the
// entries itself.
//
// Submitting a playlist video-by-video looked equivalent and was not: 46 separate
// requests meant 46 separate yt-dlp probes, the rows appeared in the library over
// several minutes, and the web app — which reconciles its list on a poll — showed
// them arriving three and four at a time, so the card's count kept moving and
// never settled. One request is one probe for the entire list, every row exists
// by the time it answers, and the count is right the first time anyone sees it.
//
// The reply is the authority on what the list actually contains: the page may
// have lazily rendered only the first stretch of a long playlist, so the run
// re-points at the URLs the server came back with.
async function runListBatch(
  run: NonNullable<typeof listRun>,
  page: { key: string; url: string },
): Promise<void> {
  // The rows were already claimed as "waiting" by runList, before the first paint
  // — nothing is downloading yet, and a page full of spinners while one probe
  // works through the list would be the wrong picture twice over.
  try {
    const res = await send<{ items: Item[] }>({ type: 'submitList', url: page.url });
    // An older server that doesn't echo webpage_url leaves us nothing to pair the
    // items back to their thumbnails with; keep the page's own URLs in that case
    // and let each row's poll pick the state up.
    const items = (res.items ?? []).filter((it): it is Item & { webpage_url: string } =>
      typeof it.webpage_url === 'string' && !!it.webpage_url,
    );
    if (items.length) {
      // Entries the page never rendered are part of the list too — adopt the
      // server's set wholesale so the pill counts the real thing.
      run.urls = items.map((it) => it.webpage_url);
      run.started = new Set(run.urls);
    }
    for (const item of items) DownloadState.for(item.webpage_url).adoptFromBatch(item);
    // Entries the server already held in a stopped state came back unchanged (a
    // submit of a known URL is deduplicated). Re-queue those explicitly, a few at
    // a time — otherwise "download all" quietly does nothing for every video that
    // was previously cancelled or failed.
    const stalled = items.filter((it) => it.status === 'canceled' || it.status === 'failed');
    for (const item of stalled) {
      if (listRun !== run) return; // cancelled out from under us
      track.get(item.webpage_url)?.retryInList();
      await sleep(120);
    }
  } catch (e) {
    // The whole list failed as one, so say so on the one control that asked for
    // it and release the rows back to their idle glyph.
    for (const url of run.urls) track.get(url)?.releaseQueuedForList();
    if (listRun === run) {
      if (run.timer) clearInterval(run.timer);
      listRun = null;
      listError = (e as Error).message || 'List download failed';
      renderListButton(listUrls().length);
      setTimeout(() => {
        listError = null;
        renderListButton(listUrls().length);
      }, 4000);
    }
  }
}

// Start the videos one at a time, for a page that ISN'T a collection the server
// can expand (a search, a feed, a channel tab). Each submit costs a probe, so
// they go a polite few at a time.
async function runListOneByOne(run: NonNullable<typeof listRun>): Promise<void> {
  const urls = run.urls;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const i = next++;
      const url = urls[i]!;
      if (listRun !== run) return; // cancelled out from under us
      const playlist = run.playlist ? { ...run.playlist, pos: i + 1 } : null;
      DownloadState.for(url).startInList(playlist);
      run.started.add(url);
      // A social thread is an ordered reading unit. Serial submission preserves
      // that order in the queue and avoids hammering X's login-gated extractor.
      await sleep(run.sequential ? 350 : 250);
    }
  };
  await Promise.all(Array.from({ length: run.sequential ? 1 : LIST_CONCURRENCY }, worker));
}

// The pill's one click, whose meaning depends on what the list is doing:
//   mid-run  → CANCEL the whole list
//   armed    → commit and start
//   idle     → arm, and ask
async function runList(): Promise<void> {
  if (listRun) return cancelList();
  if (!listArmed) {
    armList();
    return;
  }
  disarmList();
  const urls = listUrls();
  const page = adapter.playlistPage(location.href);
  const socialList = pageList();
  // A collection expands from its own URL server-side, so it may run even before
  // the page has lazily rendered its rows; a plain page has nothing to submit
  // without visible thumbnails.
  if (!urls.length && !page) return;
  const run = {
    urls,
    // The batch path starts everything the moment it is sent, so nothing is
    // "not reached yet"; the one-by-one path fills this in as it goes.
    started: new Set<string>(page ? urls : []),
    timer: null as ReturnType<typeof setInterval> | null,
    sequential: !!socialList,
    playlist: socialList?.playlist ?? null,
    label: socialList?.label ?? 'Downloading this list',
  };
  listRun = run;
  // Claim the rows BEFORE the first paint. The batch path counts every url as
  // already launched (one request covers them all), so if their states were still
  // showing the PREVIOUS run's terminal glyphs when the pill first rendered, it
  // would read "all settled" and declare the run finished before the request had
  // even been sent — the pill dropped straight back to its idle offer while eight
  // downloads quietly started behind it.
  if (page) for (const url of urls) DownloadState.for(url).markQueuedForList();
  run.timer = setInterval(() => renderListButton(run.urls.length), 300);
  renderListButton(urls.length);
  if (page) await runListBatch(run, page);
  else await runListOneByOne(run);
}

// ---- multi-select mode ---------------------------------------------
//
// Instead of blindly downloading every video a page shows (which swept in the
// recommendation rail), let the user OPT IN to a selection: toggle "Select", tick
// the thumbnails they want — with the mature quick-select shortcuts (Select all,
// Select all in this list, and shift-click to range-select) — then download just
// those. The bottom-right "Download all" pill stays for genuine collections; this
// is the general-purpose tool for everywhere else.
let selecting = false;
const selected = new Set<string>(); // canonical urls ticked
// Anchor of the last box toggled, by index into listAllUrls(), so shift-click can
// fill the range between it and the next click (the file-manager gesture).
let lastToggledIndex = -1;

let fabStackEl: HTMLElement | null = null;
let selectToggle: HTMLButtonElement | null = null;
let selectBar: HTMLElement | null = null;
let selectCount: HTMLElement | null = null;
let selectAllListBtn: HTMLButtonElement | null = null;
let selectDlBtn: HTMLButtonElement | null = null;
let selectDlLabel: HTMLElement | null = null;

// The fixed bottom-right column that stacks the "Select" toggle over the
// "Download all" pill, so the two controls share one corner instead of fighting
// for it.
function fabStack(): HTMLElement {
  if (!fabStackEl) {
    fabStackEl = document.createElement('div');
    fabStackEl.className = 'orca-fab-stack';
    document.body.appendChild(fabStackEl);
    window.addEventListener('resize', positionFabStack, { passive: true });
  }
  return fabStackEl;
}

// The bottom-right corner is the web's default home for a floating action button,
// so it is routinely already taken — X parks its Grok button there, and plenty of
// sites put a back-to-top or chat bubble in the same spot. Sitting on top of one
// hides a control the user came for, and (because the toggle is clickable) steals
// its clicks.
//
// So the stack ASKS what is under it and climbs above whatever it finds, rather
// than hard-coding an offset per site. Only compact floating controls count as
// blockers: a full-width sticky header/footer or a page-sized overlay is not
// something to dodge — there would be nowhere to go.
const FAB_BASE = 24; // resting offset from the viewport bottom (matches the CSS)
const FAB_GAP = 12; // breathing room left between us and the control we cleared

function ownFixedBox(el: Element): DOMRect | null {
  for (let n: HTMLElement | null = el as HTMLElement; n && n !== document.body; n = n.parentElement) {
    const position = getComputedStyle(n).position;
    if (position === 'fixed' || position === 'sticky') return n.getBoundingClientRect();
  }
  return null;
}

// The foreign floating control overlapping the stack right now, if any.
function fabBlocker(stack: HTMLElement): DOMRect | null {
  const r = stack.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const probes: [number, number][] = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.right - 6, r.bottom - 6],
    [r.right - 6, r.top + 6],
  ];
  for (const [x, y] of probes) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (stack.contains(el) || el === document.body || el === document.documentElement) continue;
      const box = ownFixedBox(el);
      if (!box) continue;
      if (box.width > window.innerWidth * 0.5 || box.height > window.innerHeight * 0.5) continue;
      return box;
    }
  }
  return null;
}

function positionFabStack(): void {
  const stack = fabStackEl;
  if (!stack || !stack.firstElementChild) return;
  let bottom = FAB_BASE;
  stack.style.bottom = `${bottom}px`;
  // Climbing clear of one control can land on the next one up (a site with a
  // whole rail of floating buttons), so re-probe — but only a few times, and
  // never so far up that the stack ends up marooned in the middle of the page.
  for (let i = 0; i < 3; i++) {
    const blocker = fabBlocker(stack);
    if (!blocker) break;
    const next = Math.round(window.innerHeight - blocker.top + FAB_GAP);
    if (next <= bottom || next > window.innerHeight * 0.5) break;
    bottom = next;
    stack.style.bottom = `${bottom}px`;
  }
}

function textSpan(text: string, cls = ''): HTMLElement {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

// Offer the "Select" toggle wherever the page shows a gridful of videos (whether or
// not it is a downloadable-as-one collection). Hidden while already selecting — the
// action bar owns the gesture then.
function ensureSelectToggle(): void {
  const show = !selecting && listAllUrls().length >= LIST_MIN;
  if (show && !selectToggle) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'orca-select-toggle';
    btn.append(glyphSvg('squareCheck'), textSpan('Select'));
    btn.title = 'Select videos to download';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      enterSelect();
    });
    selectToggle = btn;
    fabStack().prepend(btn);
  } else if (!show && selectToggle) {
    selectToggle.remove();
    selectToggle = null;
  }
}

function enterSelect(): void {
  selecting = true;
  lastToggledIndex = -1;
  document.body.classList.add('orca-selecting');
  ensureSelectToggle(); // removes the toggle
  ensureSelectBar();
  syncSelectBoxes();
  renderSelectBar();
}

function exitSelect(): void {
  if (!selecting) return;
  selecting = false;
  document.body.classList.remove('orca-selecting');
  removeSelectBoxes();
  renderSelectBar(); // hides the bar
  ensureSelectToggle(); // brings the toggle back
}

// The floating action bar: live count, the quick-select shortcuts, and the commit.
function ensureSelectBar(): void {
  if (selectBar) return;
  const bar = document.createElement('div');
  bar.className = 'orca-select-bar';
  selectCount = textSpan('0 selected', 'orca-select-count');
  const allBtn = mkBarBtn('All', () => selectAll(false));
  selectAllListBtn = mkBarBtn('All in list', () => selectAll(true));
  const clearBtn = mkBarBtn('Clear', clearSelection);
  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'orca-select-dl';
  selectDlLabel = textSpan('Download');
  dlBtn.append(glyphSvg('cloudDownload'), selectDlLabel);
  dlBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void downloadSelected();
  });
  selectDlBtn = dlBtn;
  const doneBtn = mkBarBtn('Done', exitSelect);
  doneBtn.classList.add('orca-select-done');
  bar.append(selectCount, allBtn, selectAllListBtn, clearBtn, doneBtn, dlBtn);
  document.body.appendChild(bar);
  selectBar = bar;
}

function mkBarBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'orca-select-btn';
  b.textContent = text;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

function renderSelectBar(): void {
  if (!selectBar) return;
  selectBar.style.display = selecting ? 'flex' : 'none';
  if (!selecting) return;
  const n = selected.size;
  if (selectCount) selectCount.textContent = n === 1 ? '1 selected' : `${n} selected`;
  if (selectDlLabel) selectDlLabel.textContent = n ? `Download ${n}` : 'Download';
  if (selectDlBtn) selectDlBtn.toggleAttribute('disabled', n === 0);
  // "All in list" only means something distinct where the page has a scoped list
  // (a watch page's queue beside its recs); on a plain grid it equals "All".
  if (selectAllListBtn)
    selectAllListBtn.style.display = adapter.listMemberSelector(location.href) ? '' : 'none';
}

// Give every on-screen thumbnail a full-tile toggle overlay while selecting, and
// keep their ticks in sync with the selection. Called on each scan so thumbnails
// that scroll into view pick one up.
function syncSelectBoxes(): void {
  if (!selecting) return;
  for (const a of thumbAnchors()) {
    const url = anchorUrl(a);
    if (!url) continue;
    let box = a.querySelector<HTMLElement>(':scope > .orca-select-box');
    if (!box) box = mountSelectBox(a);
    box.classList.toggle('orca-checked', selected.has(url));
  }
}

function mountSelectBox(anchor: HTMLAnchorElement): HTMLElement {
  const box = document.createElement('div');
  box.className = 'orca-select-box';
  const tick = document.createElement('span');
  tick.className = 'orca-select-tick';
  tick.appendChild(glyphSvg('check'));
  box.appendChild(tick);
  box.addEventListener('click', (e) => onBoxClick(e, anchor));
  // Swallow the press so it never reaches the thumbnail link underneath.
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
    box.addEventListener(t, (ev) => ev.stopPropagation());
  }
  if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
  anchor.appendChild(box);
  return box;
}

function removeSelectBoxes(): void {
  for (const b of Array.from(document.querySelectorAll('.orca-select-box'))) b.remove();
}

function onBoxClick(e: MouseEvent, anchor: HTMLAnchorElement): void {
  e.preventDefault();
  e.stopPropagation();
  const url = anchorUrl(anchor);
  if (!url) return;
  const order = listAllUrls();
  const idx = order.indexOf(url);
  const turnOn = !selected.has(url);
  if (e.shiftKey && lastToggledIndex >= 0 && idx >= 0) {
    // Range-fill between the last toggle and this one, matching this cell's new
    // state — the shift-click gesture users know from file managers.
    const lo = Math.min(idx, lastToggledIndex);
    const hi = Math.max(idx, lastToggledIndex);
    for (let i = lo; i <= hi; i++) {
      const u = order[i];
      if (!u) continue;
      if (turnOn) selected.add(u);
      else selected.delete(u);
    }
  } else if (turnOn) selected.add(url);
  else selected.delete(url);
  if (idx >= 0) lastToggledIndex = idx;
  syncSelectBoxes();
  renderSelectBar();
}

// Quick-select: every video on the page, or only the scoped list's members.
function selectAll(scopedToList: boolean): void {
  for (const u of scopedToList ? listUrls() : listAllUrls()) selected.add(u);
  syncSelectBoxes();
  renderSelectBar();
}

function clearSelection(): void {
  selected.clear();
  lastToggledIndex = -1;
  syncSelectBoxes();
  renderSelectBar();
}

// Start the selection, then leave select mode so the per-thumbnail rings — which
// are views of these same downloads — are visible reporting their progress. Each
// goes through its own DownloadState (submit, or /retry for a stopped one), a few
// at a time so each probe doesn't hit the server at once.
async function downloadSelected(): Promise<void> {
  const urls = [...selected];
  if (!urls.length) return;
  selected.clear();
  exitSelect();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const u = urls[next++]!;
      DownloadState.for(u).startInList(null);
      await sleep(250);
    }
  };
  await Promise.all(Array.from({ length: LIST_CONCURRENCY }, worker));
}

function scan(): void {
  if (!features.inpageButton) return;
  // Thumbnails first: the overlay pass skips a hover-preview player that is lying
  // on top of a thumbnail button, so those buttons have to exist by then.
  scanThumbs();
  mountVideoOverlays();
  syncMountedIdentity();
  ensureListButton();
  syncSelectBoxes();
}

// Swap in the adapter set for freshly imported user rules (dynamic import), forget
// cached verdicts, and re-scan from scratch. Keyed on the serialized rule list so a
// no-op refresh costs nothing.
// The hosts the SERVER's website registry covers. Empty until the first fetch
// lands (or forever, if the server is unreachable) — in which case recognition
// stays on the conservative generic adapter, exactly as before.
let registryHosts: string[] = [];

// Ask the server which sites it is configured to download from. One cheap sealed
// request per tab: the registry is operator-edited, not per-page state. A failure
// leaves `registryHosts` untouched so a transient outage never downgrades a page
// that is already recognising videos.
async function refreshRegistryHosts(): Promise<void> {
  try {
    const { websites } = await send<{ websites: { hosts: string[]; enabled: boolean }[] }>({
      type: 'listWebsites',
    });
    if (!Array.isArray(websites)) return;
    registryHosts = websites.filter((w) => w.enabled !== false).flatMap((w) => w.hosts ?? []);
    applyAdapters(lastUserAdapters);
  } catch {
    /* offline / not configured — keep whatever we already know */
  }
}

let lastUserAdapters: UserSiteAdapter[] = [];
let adaptersKey = '';
function applyAdapters(userAdapters: UserSiteAdapter[]): void {
  lastUserAdapters = userAdapters;
  const knownVideoHost = hostInRegistry(location.hostname, registryHosts);
  const key = JSON.stringify([userAdapters, knownVideoHost]);
  if (key === adaptersKey) return;
  adaptersKey = key;
  adapter = resolveAdapter(location.hostname, userAdapters, knownVideoHost);
  thumbResult.clear();
  thumbQueued.clear();
  thumbQueue.length = 0;
  // The new rules may recognise a different set of anchors, or resolve the same
  // anchor to a different video — so every mounted thumbnail button is suspect.
  // Tear them all down and let the rescan re-mount from scratch.
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-orca-thumb]'))) {
    delete a.dataset.orcaThumb;
    thumbBtns.get(a)?.dispose();
    thumbBtns.delete(a);
    a.querySelector(':scope > .orca-thumb-wrap')?.remove();
  }
  if (started) scan();
}

async function refreshAdapters(): Promise<void> {
  try {
    const cfg = await send<{ siteAdapters?: UserSiteAdapter[] }>({ type: 'getConfig' });
    applyAdapters(sanitizeUserAdapters(cfg.siteAdapters ?? []));
  } catch {
    /* offline / not configured — keep the current adapter */
  }
  // Retry the registry until it lands: on a tab opened before the server came up
  // (or before a token existed) the first attempt fails, and without this the page
  // would stay on conservative recognition for its whole life.
  if (registryHosts.length === 0) await refreshRegistryHosts();
}

let scanTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleScan(): void {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, 400);
}

browser.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string; event?: ProgressEvent };
  if (m.type === 'progress' && m.event) {
    byItem.get(m.event.id)?.onProgress(m.event);
  }
});

// Begin watching the page for videos. Idempotent — only the first call wires up
// the scan, the mutation observer, and the SPA-navigation watcher.
let started = false;
function start(): void {
  if (started) return;
  started = true;
  void refreshBackendHealth();
  void refreshRegistryHosts();
  // A config read only says credentials exist; this real authenticated probe is
  // what turns every in-page control into the warning globe as soon as the
  // backend drops, and restores it when the server returns.
  setInterval(() => void refreshBackendHealth(), 5000);
  scan();
  const obs = new MutationObserver(scheduleScan);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  // SPA navigations (YouTube etc.) don't reload — rescan on URL change. Also
  // periodically re-fetch user site adapters so a NEWLY IMPORTED platform takes
  // effect on already-open tabs without a reload (dynamic import). getConfig is a
  // cheap local read (storage / GM store), never a network round-trip.
  let last = location.href;
  let ticks = 0;
  setInterval(() => {
    if (++ticks % 15 === 0) void refreshAdapters();
    if (location.href !== last) {
      last = location.href;
      scheduleScan();
      // Refresh buttons whose <video> the SPA reused for the new video (a rescan
      // skips them as already-decorated), and drop any whose video is now gone.
      for (let i = mounted.length - 1; i >= 0; i--) {
        const m = mounted[i]!;
        if (!m.video.isConnected) {
          mounted.splice(i, 1);
          // Drop the paired reveal too: left in place it keeps a strong ref to
          // the detached video/button (via its rect closure), leaking them and
          // wasting a getBoundingClientRect per pointermove frame on a dead node.
          const ri = overlayReveals.findIndex((o) => o.el === m.btn.el);
          if (ri >= 0) {
            const [o] = overlayReveals.splice(ri, 1);
            if (o!.idleTimer) clearTimeout(o!.idleTimer);
            if (o!.leaveTimer) clearTimeout(o!.leaveTimer);
          }
          // Let go of the state too, so a video nobody is showing any more stops
          // being tracked (an in-flight one is kept — see disposeIfDone).
          m.btn.dispose();
        } else {
          m.lastUrl = resolveVideoUrl(m.video);
          m.btn.syncUrl();
        }
      }
    }
  }, 1000);
}

// Ask the background/shim for config; start watching once the connection is set
// up and the in-page button is enabled. Returns true once started.
async function tryStart(): Promise<boolean> {
  try {
    const cfg = await send<{
      features: { inpageButton: boolean };
      welcomeDone: boolean;
      siteAdapters?: UserSiteAdapter[];
    }>({
      type: 'getConfig',
    });
    features = cfg.features;
    applyAdapters(sanitizeUserAdapters(cfg.siteAdapters ?? []));
    if (!cfg.welcomeDone || !cfg.features.inpageButton) return false;
  } catch {
    return false;
  }
  start();
  return true;
}

async function init(): Promise<void> {
  // Private / LAN pages (a router, NAS, localhost, the Orca server itself) aren't
  // downloadable sites — never recognise a video or mount the button there.
  if (isPrivateHost(location.hostname)) return;
  if (await tryStart()) return;
  // Not configured yet. The user may set the server/token LATER — in the web
  // dashboard (the userscript mirrors it) or the popup — without reloading this
  // tab. Re-check on an interval so the button appears on its own once
  // credentials land, instead of silently requiring a manual page reload.
  const poll = setInterval(() => {
    void tryStart().then((ok) => {
      if (ok) clearInterval(poll);
    });
  }, 3000);
}

void init();
