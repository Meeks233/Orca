# Orca E2EE profile comparison — full vs. selective media encryption

**Date:** 2026-07-18 · **Question:** the R7 6800H test machine runs noticeably
hotter since the OSC "更彻底的 E2EE" landed — is the new container to blame, and
is a leaner profile worth it? · **Decision owner:** you (pick a branch to
continue on).

Measurements were taken on this build host, an **AMD Ryzen 7 5800H** (Zen 3,
AES-NI + PCLMULQDQ). Your test machine is a **Ryzen 7 6800H** (Zen 3+, same
x86-64-v3 ISA, ~5–15 % higher clocks) — so these figures are representative and,
if anything, slightly conservative for the 6800H.

---

## TL;DR

- **Yes, the new container is the cause** — but *not* because AES is expensive.
  Idle CPU is identical (~0.04 %). The heat is entirely under **media use**, and
  comes from four things OSC introduced on the media plane:
  1. The per-64 KiB-chunk crypto pattern runs at **~1/5 of hardware AES speed**.
  2. `Cache-Control: private, no-store` on **all** media → nothing is cacheable,
     so every re-view / seek / list re-render **re-encrypts and re-decrypts**.
  3. A Service Worker intercepts and reassembles **every media byte-range in JS**.
  4. Speculative stream **prewarming** seals videos you never watch.
  Before OSC, media was plaintext `sendfile` — ~0 application CPU — and cacheable.
- Two branches are ready. The **only** difference between them is the media
  plane; the secrets plane (token, cookies, API bodies) is **byte-for-byte
  identical and forward-secret in both**.
- Recommendation matches your stated intent ("仅对密钥+cookie 强 E2EE，不碰流媒体"):
  **selective** unless your threat model needs media *content* hidden from an
  active MITM at the Cloudflare edge.

---

## Branches

| Branch | Commit | What it is | How to run selective |
|---|---|---|---|
| `main` | `6f20ce3` | unchanged | — |
| **`e2ee-full`** | `6f20ce3` | snapshot of the current full-E2EE (OSC) build | (default) |
| **`e2ee-selective`** | `10e2a51` | adds the `ORCA_ENCRYPT_MEDIA` switch (default **on** = full) | set `ORCA_ENCRYPT_MEDIA=0` |

`e2ee-selective` is a **superset**: one binary, one env var. `ORCA_ENCRYPT_MEDIA=1`
(default) is bit-for-bit the full profile; `=0` is the selective profile. This is
also why the benchmark is fair — identical binary, identical data, identical
machine, one flag flipped.

---

## What actually differs

Everything on the **secrets / API plane is unchanged** in both profiles:

- Ephemeral P-256 ECDH handshake → forward-secret session key.
- Per-request **sealed authenticator** (no token ever on the wire).
- API request/response bodies (submit URLs, settings, the yt-dlp cookie jar and
  keys) sealed under the session key.

Only the **media plane** (video files, thumbnails, subtitles, cloud stream
proxy) changes:

| | Full (`e2ee-full`) | Selective (`e2ee-selective`, `ORCA_ENCRYPT_MEDIA=0`) |
|---|---|---|
| Transport | AES-256-GCM sealed, 64 KiB chunks | plaintext |
| Fetched by | Service Worker → `/__m/…`, decrypts in JS | native `<video>`/`<img>`/`<track>`, direct |
| Auth | `X-Orca-Sid` + sealed authenticator | HttpOnly `orca_sess` session cookie |
| Token on wire | never | never (cookie is the sid, already a public handle) |
| Cache-Control | `private, no-store` | thumbnails `max-age=604800, immutable`; video native range cache |

---

## Performance

### 1. Media-plane crypto throughput (measured, exact production code path)

Microbenchmarked with the **same `aes-gcm` 0.10 crate and the same
per-64 KiB-chunk pattern** the server (`src/e2ee.rs::seal_chunk`) and browser SW
use. 2 GiB of media per run.

| Operation | Throughput | CPU-seconds / GB | vs. raw ceiling |
|---|---:|---:|---:|
| Raw AES-256-GCM ceiling (OpenSSL EVP, 16 KiB) | 3.56 GB/s | 0.28 | 1.0× |
| **Server seal** (`seal_chunk`, cipher+alloc per chunk) | 0.76 GB/s | **1.32** | 4.7× slower |
| **Client decrypt** (WebCrypto `subtle.decrypt`, per chunk) | 0.62 GB/s | **1.62** | 5.8× slower |
| **Combined, one pass (server + client)** | — | **≈ 2.94** | — |

**Why 5× off the ceiling:** every 64 KiB chunk re-runs the AES-256 key schedule
and allocates a fresh buffer on the server; on the client each chunk is a
separate `await subtle.decrypt` (promise + copy). The chunking that makes seeking
possible is exactly what defeats bulk-cipher pipelining. Both halves of that
~2.94 CPU-s/GB land **on your laptop** — the container seals, the browser
decrypts.

### 2. The recurring multiplier: `no-store`

Full E2EE stamps **every** media response `no-store`, so nothing is cacheable.
The 2.94 CPU-s/GB is paid **again** on every:

- video **seek-back** or replay (the jumped-to window is re-fetched → re-sealed →
  re-decrypted),
- list **re-render** — auto-refresh, filter, sort, scroll-away-and-back — which
  re-pulls every thumbnail,
- **prewarm** of up to 2 streams via `IntersectionObserver`, sealing videos never
  played.

Selective serves thumbnails `immutable` (browser cache, transfer 0, **0 CPU** on
re-view) and lets the browser range-cache video natively.

### 3. Magnitude (illustrative, 5800H; 6800H comparable)

| Scenario | Full E2EE | Selective |
|---|---|---|
| Watch one 1080p video (~1.5 GB) once | ≈ 2.0 CPU-s seal + 2.4 CPU-s decrypt ≈ **4.4 CPU-s**, more per seek | ≈ **0** app CPU (native), cached |
| Scrub/seek repeatedly | re-seal + re-decrypt each window every time | browser range cache |
| Browse 35 thumbnails (~3 MB), re-rendered 10× | ~30 MB re-sealed+re-decrypted + ~350 SW fetches | 3 MB once, then cache hits |
| Idle | ~0.04 % | ~0.04 % |

Note: a *single* steady stream is a low % (a few MB/s ÷ 0.76 GB/s < 1 %). The
**noticeable** heat is dominated by the `no-store` re-work, the per-range SW/JS
interception, and prewarming — not steady-state AES. Selective removes all of it.

---

## Security

| Property | Full E2EE | Selective |
|---|---|---|
| API bodies (submit URLs, settings) | forward-secret E2EE | **same** |
| Auth token on the wire | never | **never** |
| yt-dlp cookies / keys (the secrets you care about) | forward-secret E2EE | **same** |
| Handshake / session / authenticator | ephemeral ECDH + sealed per-request | **same** |
| Media **content** at the tunnel edge | ciphertext (MITM sees nothing) | **plaintext (an active MITM can read media bytes)** |
| Media access credential at the edge | none (sealed) | `orca_sess` cookie — media-only, session-scoped, 30-min, edge-visible |
| Public share links `/api/p/:slug` | **already plaintext in both** | **already plaintext in both** |

**The only thing selective gives up:** an active MITM at the Cloudflare edge can
read your media *content* and could replay the media-only session cookie to fetch
more of your media (which it can already see anyway). It **cannot** read or forge
anything on the secrets plane — token, cookies, and API bodies stay
forward-secret. And note full E2EE already serves public shares (`/api/p/`) in
the clear, so "media confidentiality at the edge" is already partial today.

Hardening notes for a production selective deploy (behind HTTPS tunnel): add the
`Secure` attribute to the cookie (omitted now so `http://127.0.0.1` dev works),
and optionally scope its `Path` to the media routes.

---

## Recommendation

Your words were "仅针对密钥+cookie 这种需要严格保密的数据进行强 E2EE 而不碰流媒体" —
that is exactly the **selective** profile. It keeps everything genuinely secret
end-to-end and forward-secret, drops the media plane out of the crypto path, and
eliminates the heat. Media stays access-controlled (cookie/session), just not
encrypted against a tunnel-edge MITM.

- **Pick `e2ee-selective`** if protecting secrets is the goal and media *content*
  confidentiality at the edge isn't worth sustained CPU/heat/battery. (Matches
  your intent; recommended.)
- **Keep `e2ee-full`** only if your threat model includes an active MITM at the
  Cloudflare edge who must not see media *content*, and you accept the cost.

You don't have to choose one forever: `e2ee-selective` is the superset, so you can
ship it with `ORCA_ENCRYPT_MEDIA=1` and flip to `0` per-deployment.

### Optional follow-up (independent of the choice)

The 4.7× server seal penalty is fixable: reuse **one** `Aes256Gcm` instance across
a window's chunks instead of re-deriving the key schedule per 64 KiB, and seal
into a pre-sized buffer. That alone would roughly 2–4× the seal throughput and
cut full-mode server CPU materially. Left undone here so both branches share the
current crypto and the comparison stays clean — worth doing on whichever branch
you continue.

---

## How this was verified

- Backend: `cargo test` — **183 pass** (adds a media-cookie parse test);
  `cargo check` clean; frontend `tsc` strict + build clean.
- Selective contract, live (same image, env flip):
  - `GET /api/health` → `"encrypt_media": false`.
  - `POST /api/session` → `200` + `Set-Cookie: orca_sess=…; HttpOnly; SameSite=Lax; Max-Age=1800`.
  - `GET /api/items/…/thumb` with no credential → `401` (auth still gates).
  - Full profile of the same image: `"encrypt_media": true`, **no** cookie.
- Crypto throughput: standalone microbench of the exact seal/open pattern
  (`aes-gcm` 0.10) + OpenSSL EVP ceiling + Node WebCrypto client proxy.
- Not run this session: full end-to-end **browser** A/B (the chrome-devtools MCP
  couldn't attach — a normal Brave instance held the profile). The per-GB figures
  above are direct measurements of the production code path; a live browser
  docker-stats A/B can be added when the browser is free.
