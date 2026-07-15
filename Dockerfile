# syntax=docker/dockerfile:1
# ---- builder ----
# Pinned by digest for reproducible builds (rust:1.97-bookworm as of 2026-07).
FROM rust:1.97-bookworm@sha256:a49aec4d4647c73d66a9684df1bd8a73a1eb4c0734b32b94df3f86361dd54ce7 AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock build.rs ./
COPY migrations ./migrations
COPY src ./src
COPY web ./web
# Cache mounts persist the cargo registry + target dir across builds, so an
# incremental rebuild only recompiles the `whale` crate instead of every
# dependency (minutes -> seconds in the dev loop). The compiled binary lives in
# the cache mount, so copy it to a normal path for the runtime stage to pick up.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo build --release --locked \
    && cp /app/target/release/whale /app/whale

# ---- runtime ----
# Pinned by digest for reproducible builds (debian:bookworm-slim as of 2026-07).
FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818
ARG YTDLP_VERSION=2026.07.04
LABEL org.opencontainers.image.ytdlp="${YTDLP_VERSION}"
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg python3 ca-certificates curl \
    && curl -L "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
        -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/whale /usr/local/bin/whale
RUN useradd -m -u 10001 whale && mkdir -p /data /downloads && chown whale /data /downloads
USER whale
ENV WHALE_DATA_DIR=/data WHALE_DOWNLOAD_DIR=/downloads WHALE_BIND=0.0.0.0:8080
VOLUME ["/data", "/downloads"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fsS http://localhost:8080/api/health || exit 1
ENTRYPOINT ["whale"]
CMD ["serve"]
