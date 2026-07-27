# Development and Release

## Layout

Rust code is in `src/`, migrations in `migrations/`, frontend source in
`frontend/src/`, committed frontend output in `web/`, and the Tauri application in
`app/`. `web/` is both embedded by the backend and packaged by Tauri.

All hand-written frontend and frontend-tooling code must be strict TypeScript.
Do not add `.js`, `.mjs`, `.cjs`, or `.jsx` source files. The only permitted
JavaScript files are the generated browser bundles `web/app.js`, `web/theme.js`,
and `web/sw.js`; edit their TypeScript sources under `frontend/` and rebuild.
`npm run check:javascript` enforces this rule locally and in CI.

## Checks

```bash
cargo +1.97.0 fmt --all -- --check
cargo +1.97.0 clippy --all-targets --all-features --locked -- -D warnings
cargo +1.97.0 test --locked
cd frontend && npm ci && npm run check && npm audit --audit-level=high
```

After frontend edits, commit the regenerated `web/` files. CI rebuilds and fails
when the bundle differs. New database changes require a new numbered migration;
never modify a migration that may have run in a released installation.

## Versioning

Orca has one version, written down in nine manifests and derived into two more
places (the Android `versionCode`, which is `major*1000000 + minor*1000 + patch`,
and the fastlane changelog filename). `app/src-tauri/tauri.conf.json` is
canonical because tauri-cli turns it into the Android versionName/versionCode.

Never edit those by hand — `scripts/release.zsh` rewrites all of them together.
`scripts/check-versions.sh` asserts they agree and runs on every push, so a
partial bump fails CI immediately instead of surfacing as a rejected tag or a
stale "what's new" in Play.

## Release Process

Write the release notes first — the tooling refuses to tag without them:

1. Add a `## MAJOR.MINOR.PATCH — YYYY-MM-DD` section to
   [CHANGELOG.md](../CHANGELOG.md). It becomes the GitHub Release body.
2. Add `fastlane/metadata/android/{en-US,zh-CN}/changelogs/<versionCode>.txt`.
   These are the only source for Play's and F-Droid's "what's new".

Then cut it:

```bash
orl                 # patch bump from the latest tag  (v0.1.4 → v0.1.5)
orl --version       # minor bump                      (v0.1.4 → v0.2.0)
orl --big-version   # major bump                      (v0.1.4 → v1.0.0)
orl --dry-run       # preflight only: nothing committed, tagged, or pushed
```

`orl` derives the next version from the highest `vX.Y.Z` git tag and hands it to
`scripts/release.zsh`, which preflights (branch, clean tree, tag unused, in sync
with origin, notes present), rewrites every version declaration, runs the test
suites, asks for confirmation, then pushes `main` and an annotated tag. Call the
script directly to pin a version by hand.

The tag triggers two workflows:

- `ci.yml` → the GHCR image, tagged `:v0.1.0`, `:0.1.0`, and `:sha-<commit>`,
  published only after every gate passes.
- `release.yml` → the signed Android APK/AAB, the userscript, and one GitHub
  Release carrying both plus `SHA256SUMS`. It also rehearses the F-Droid recipe
  from source; that job is intentionally not a release blocker.

Two things stay manual on purpose. Google Play uploads run the Release workflow
via `workflow_dispatch` with `publish_play=true` (see
[RELEASING_ANDROID.md](RELEASING_ANDROID.md)), and F-Droid inclusion is a merge
request against `fdroid/fdroiddata` carrying
`packaging/fdroid/com.meeks233.orca.yml`.

Never distribute the CI debug artifact from `android.yml` as a release APK.

Scheduled yt-dlp updates commit only a version/checksum pair. They use the same CI
gate and image publisher as normal source changes.
