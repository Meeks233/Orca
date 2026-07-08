# Docker & CI (auto-build on yt-dlp release)

## 1. Image design

- **Multi-stage**: a Rust builder stage compiles the static-ish binary; a slim runtime stage
  adds `python3`, a **pinned `yt-dlp`**, and `ffmpeg`.
- **No hot-update**: `yt-dlp` version is a build `ARG` baked in. Updating yt-dlp = building a
  new image. This keeps every image reproducible and pinned.
- Runtime user is non-root; `/data` and `/downloads` are volumes.

### `Dockerfile` (shape)

```dockerfile
# ---- builder ----
FROM rust:1-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY .sqlx ./.sqlx                 # offline query cache so no DB needed at build (if using sqlx)
COPY src ./src
COPY web ./web
ENV SQLX_OFFLINE=true
RUN cargo build --release --locked

# ---- runtime ----
FROM debian:bookworm-slim
ARG YTDLP_VERSION=2025.07.01        # <-- bumped by CI
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg python3 ca-certificates curl \
    && curl -L "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
        -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/whale /usr/local/bin/whale
RUN useradd -m -u 10001 whale && mkdir -p /data /downloads && chown whale /data /downloads
USER whale
ENV WHALE_DATA_DIR=/data WHALE_DOWNLOAD_DIR=/downloads WHALE_BIND=0.0.0.0:8080
VOLUME ["/data", "/downloads"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fsS http://localhost:8080/api/health || exit 1
ENTRYPOINT ["whale"]
CMD ["serve"]
```
> `web/` assets are embedded into the binary at compile time (`rust-embed`), so the runtime
> image needs no separate asset copy. Frontend edits require a rebuild — acceptable for v1.

### `docker-compose.yml` (shape)
```yaml
services:
  whale:
    image: ghcr.io/<owner>/whale:latest
    environment:
      WHALE_TOKEN: "change-me"
      WHALE_CONCURRENCY: "2"
    volumes:
      - ./data:/data
      - ./downloads:/downloads
    ports: ["8080:8080"]
    restart: unless-stopped
```

## 2. GitHub Actions

Two workflows in `.github/workflows/`:

### `build.yml` — build & push on code changes
Triggers: `push` to `main`, tags, and `workflow_dispatch`.
Steps: checkout → (optional `cargo test`) → `docker/build-push-action` → push to
`ghcr.io/<owner>/whale` with tags `latest` + `sha-<short>`. Passes the current pinned
`YTDLP_VERSION` build-arg (read from a tracked `YTDLP_VERSION` file or repo variable).

### `ytdlp-update.yml` — follow upstream yt-dlp releases
Triggers: `schedule` (e.g. daily cron) + `workflow_dispatch`.
Logic:
1. Query the latest yt-dlp release tag (GitHub API `releases/latest`).
2. Compare to the currently pinned version (tracked in a `YTDLP_VERSION` file, or the latest
   image's `org.opencontainers...ytdlp` label).
3. If newer: build the image with `--build-arg YTDLP_VERSION=<new>`, tag it
   `latest`, `ytdlp-<new>`, and push to GHCR; optionally open/commit a bump to the
   `YTDLP_VERSION` file so the pin is tracked in git.
4. If unchanged: no-op.

> Because the yt-dlp version is a build-arg + label, each image is traceable to an exact
> yt-dlp release, satisfying "reproducible, no hot-update, auto-follow upstream".

### Notes
- Use `permissions: packages: write` + `GITHUB_TOKEN` to push to GHCR.
- Cache Rust builds with `Swatinem/rust-cache` or buildx cache to keep the daily job cheap.
- Tag scheme: `latest` (moving), `ytdlp-<version>` (immutable-ish per yt-dlp release),
  `sha-<short>` (per code commit).
