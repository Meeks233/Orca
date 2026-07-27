#!/usr/bin/env zsh
# release.zsh — Orca release helper.
#
# What it does:
#   1. Preflight (branch, clean tree, tag uniqueness, in sync with origin).
#   2. Rewrites every version declaration to the target version — nine manifests,
#      two lockfiles, and the F-Droid recipe's Builds entry — then verifies they
#      agree with scripts/check-versions.sh.
#   3. Runs the test suites.
#   4. Shows exactly what will be published and where, and waits for "yes".
#   5. Commits the bump (if any), pushes main, then creates an annotated tag and
#      pushes it — which triggers .github/workflows/release.yml (userscript +
#      signed Android APK/AAB + GitHub Release + F-Droid rehearsal) and
#      ci.yml's image job (GHCR container image).
#
# It NEVER touches credentials: GHCR auth, the Android keystore, and the Play
# service account all live in CI. Nothing here logs you in or stores secrets.
#
# The version is normally chosen for you by the `orl` shell function, which
# derives it from the latest git tag. Call this directly to pin one by hand.
#
# Usage:
#   scripts/release.zsh v0.1.0              # bump, verify, tag, push
#   scripts/release.zsh v0.1.0 --dry-run    # everything except commit/tag/push
#   scripts/release.zsh v0.1.0 --yes        # no y/N prompt (full-auto)
#   scripts/release.zsh v0.1.0 --skip-tests # trust the CI gate instead
#
set -euo pipefail

REPO_OWNER="Meeks233"
REPO_NAME="Orca"
IMAGE="ghcr.io/meeks233/orca"
RELEASE_BRANCH="main"
LOCALES=(en-US zh-CN)
FDROID_RECIPE="packaging/fdroid/com.meeks233.orca.yml"

print -P "%F{cyan}==> Orca release helper%f"

# ---- args ----------------------------------------------------------------
VERSION="${1:-}"
DRY_RUN=false
ASSUME_YES=false
SKIP_TESTS=false
shift 2>/dev/null || true
for arg in "$@"; do
  case "$arg" in
    --dry-run)       DRY_RUN=true ;;
    --yes|--auto|-y) ASSUME_YES=true ;;
    --skip-tests)    SKIP_TESTS=true ;;
    *) print -P "%F{red}error:%f unknown flag '$arg'. Usage: scripts/release.zsh vX.Y.Z [--dry-run] [--yes] [--skip-tests]"; exit 1 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  print -P "%F{red}error:%f missing version. Usage: scripts/release.zsh vX.Y.Z [--dry-run]"
  exit 1
fi
# No pre-release suffixes: the Android versionCode arithmetic and the F-Droid
# recipe both assume a plain three-part version.
if [[ ! "$VERSION" =~ '^v[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
  print -P "%F{red}error:%f '$VERSION' is not a SemVer tag (expected vMAJOR.MINOR.PATCH)."
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

BARE="${VERSION#v}"
local -a parts=("${(@s:.:)BARE}")
# Mirrors tauri-cli's mapping; check-versions.sh and release.yml derive it the
# same way.
CODE=$(( parts[1] * 1000000 + parts[2] * 1000 + parts[3] ))

# ---- preflight -----------------------------------------------------------
fail() { print -P "%F{red}✗ $1%f"; exit 1; }
ok()   { print -P "%F{green}✓ $1%f"; }

CUR_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$CUR_BRANCH" == "$RELEASE_BRANCH" ]] \
  || fail "on branch '$CUR_BRANCH', expected '$RELEASE_BRANCH'. Checkout $RELEASE_BRANCH first."
ok "on branch $RELEASE_BRANCH"

if [[ -n "$(git status --porcelain)" ]]; then
  print -P "%F{yellow}⚠ working tree is dirty:%f"
  git status --short
  fail "commit or stash changes first — the version bump must be the only thing this script commits."
fi
ok "working tree clean"

if git rev-parse "$VERSION" >/dev/null 2>&1; then
  fail "tag $VERSION already exists. Bump the version or delete the tag."
fi
ok "tag $VERSION is new"

git fetch --quiet origin "$RELEASE_BRANCH" || true
if git rev-parse "origin/$RELEASE_BRANCH" >/dev/null 2>&1; then
  BEHIND="$(git rev-list --count HEAD..origin/$RELEASE_BRANCH)"
  [[ "$BEHIND" -eq 0 ]] || fail "local $RELEASE_BRANCH is $BEHIND commit(s) behind origin. Pull first."
  ok "in sync with origin/$RELEASE_BRANCH"
fi

# Release notes and store listings are written by a human, not generated. Check
# for them BEFORE touching any file, so a missing one costs nothing to fix.
grep -q "^## $BARE " CHANGELOG.md \
  || fail "CHANGELOG.md has no '## $BARE — YYYY-MM-DD' section. Write the release notes first."
ok "CHANGELOG.md has a section for $BARE"

for loc in $LOCALES; do
  f="fastlane/metadata/android/$loc/changelogs/$CODE.txt"
  [[ -s "$f" ]] || fail "missing store changelog $f (versionCode $CODE). Write it first — Play and F-Droid both read it."
done
ok "store changelogs present for versionCode $CODE"

# ---- bump ----------------------------------------------------------------
print -P "%F{cyan}==> setting every version declaration to $BARE%f"

python3 - "$BARE" "$CODE" "$FDROID_RECIPE" <<'PY'
import json, re, sys
from pathlib import Path

version, code, recipe = sys.argv[1], sys.argv[2], sys.argv[3]

def edit(path, fn):
    p = Path(path)
    before = p.read_text()
    after = fn(before)
    if after != before:
        p.write_text(after)
        print(f"  bumped {path}")

def cargo(text):
    # Only the [package] table's own version; dependency versions must not move.
    head, sep, rest = text.partition("\n[")
    return re.sub(r'^version = ".*"$', f'version = "{version}"', head, count=1, flags=re.M) + sep + rest

for f in ("Cargo.toml", "app/src-tauri/Cargo.toml"):
    edit(f, cargo)

def json_root(text):
    # Rewrite in place rather than json.dump: these files are hand-maintained
    # and a reserialisation would reformat and churn the whole diff.
    out = re.sub(r'("version"\s*:\s*)"[^"]*"', rf'\g<1>"{version}"', text, count=1)
    # npm lockfiles repeat the root version inside packages[""].
    return re.sub(r'("":\s*\{\s*\n(?:\s*"[^"]*":.*\n)*?\s*"version":\s*)"[^"]*"',
                  rf'\g<1>"{version}"', out, count=1)

for f in ("app/src-tauri/tauri.conf.json",
          "frontend/package.json", "frontend/package-lock.json",
          "extension/package.json", "extension/package-lock.json"):
    edit(f, json_root)

def fdroid(text):
    text = re.sub(r'^CurrentVersion: .*$', f'CurrentVersion: {version}', text, count=1, flags=re.M)
    text = re.sub(r'^CurrentVersionCode: .*$', f'CurrentVersionCode: {code}', text, count=1, flags=re.M)
    if re.search(rf'^  - versionName: {re.escape(version)}$', text, flags=re.M):
        return text
    # Clone the newest Builds entry — the recipe (toolchain, sudo/init steps,
    # scandelete, output path) is identical release to release; only the three
    # identity fields move. Entries stay in ascending order, as fdroiddata wants.
    lines = text.splitlines(keepends=True)
    starts = [i for i, l in enumerate(lines) if l.startswith("  - versionName:")]
    if not starts:
        sys.exit(f"error: {recipe} has no Builds entries to clone")
    start = starts[-1]
    end = start + 1
    while end < len(lines) and (lines[end].startswith("    ") or lines[end].startswith("      ") or not lines[end].strip()):
        end += 1
    # Trailing blank lines belong after the block we insert, not inside it.
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1
    entry = "".join(lines[start:end])
    entry = re.sub(r'^  - versionName: .*$', f'  - versionName: {version}', entry, count=1, flags=re.M)
    entry = re.sub(r'^    versionCode: .*$', f'    versionCode: {code}', entry, count=1, flags=re.M)
    entry = re.sub(r'^    commit: .*$', f'    commit: v{version}', entry, count=1, flags=re.M)
    return "".join(lines[:end]) + entry + "".join(lines[end:])

edit(recipe, fdroid)
PY

# The lockfiles record each workspace crate's own version, so a bump that skips
# them makes every `--locked` build fail. `cargo update -w` rewrites just those.
for ws in . app/src-tauri; do
  (cd "$ws" && cargo update --workspace --offline --quiet 2>/dev/null || cargo update --workspace --quiet)
done
ok "workspace lockfiles refreshed"

scripts/check-versions.sh "$VERSION"

# ---- tests ---------------------------------------------------------------
if $SKIP_TESTS; then
  print -P "%F{yellow}--skip-tests: relying on the CI gate to catch breakage.%f"
else
  print -P "%F{cyan}==> running tests%f"
  cargo test --locked || fail "backend tests failed — not releasing."
  (cd frontend && npm ci --silent && npm run check) || fail "frontend checks failed — not releasing."
  (cd extension && npm ci --silent && npm run dist) || fail "userscript build failed — not releasing."
  ok "tests passed"
fi

# ---- summary -------------------------------------------------------------
COMMIT="$(git rev-parse --short HEAD)"
BUMPED="$(git status --porcelain)"
print -P ""
print -P "%F{cyan}==> ready to release%f"
cat <<EOF
  version     : $VERSION  (Android versionCode $CODE)
  commit      : $COMMIT$( [[ -n "$BUMPED" ]] && echo " + a version-bump commit" )
  branch      : $RELEASE_BRANCH
  GitHub      : https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${VERSION}
  image       : ${IMAGE}:${BARE}  (also :${VERSION} and :sha-<commit>)
  assets      : orca.user.js, SHA256SUMS, plus orca-${BARE}.apk/.aab when the
                android-release keystore secrets are configured
  F-Droid     : recipe rehearsed in CI; submit ${FDROID_RECIPE} to fdroiddata by hand
  Google Play : not automatic — run the Release workflow with publish_play=true
EOF
if [[ -n "$BUMPED" ]]; then
  print -P ""
  print -P "%F{cyan}version bump to be committed:%f"
  git --no-pager diff --stat
fi

if $DRY_RUN; then
  print -P "%F{yellow}--dry-run: all checks passed, nothing committed, tagged, or pushed.%f"
  git checkout -- . 2>/dev/null || true
  print -P "%F{yellow}(version bump reverted)%f"
  exit 0
fi

# ---- confirm -------------------------------------------------------------
print -P ""
print -P "%F{yellow}This will push %F{white}$RELEASE_BRANCH%F{yellow} and tag %F{white}$VERSION%F{yellow},%f"
print -P "%F{yellow}kicking off a public release, a GHCR push, and a signed Android build.%f"
print -P "%F{yellow}This is hard to undo.%f"
if $ASSUME_YES; then
  print -P "%F{cyan}--yes set: releasing %F{white}$VERSION%F{cyan} without prompting.%f"
else
  # Version is auto-derived (by orl), so just confirm yes/no — no need to retype it.
  printf "Release %s? [y/N] " "$VERSION"
  read -r CONFIRM
  [[ "${CONFIRM:l}" == (y|yes) ]] || { print -P "%F{red}aborted.%f"; exit 1; }
fi

# ---- commit, tag, push ---------------------------------------------------
if [[ -n "$BUMPED" ]]; then
  git add -A
  git commit -m "chore(release): $BARE"
  ok "committed the version bump"
fi

# Push the branch first: the tag must be reachable from main, or `gh release
# create --verify-tag` in CI resolves a commit nobody can fetch.
git push origin "$RELEASE_BRANCH"
ok "pushed $RELEASE_BRANCH"

git tag -a "$VERSION" -m "Orca $VERSION"
ok "created tag $VERSION"
git push origin "$VERSION"
ok "pushed tag — CI is now building the release"

print -P ""
print -P "%F{green}Done.%f Watch the build:"
print -P "  https://github.com/${REPO_OWNER}/${REPO_NAME}/actions"
