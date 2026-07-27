#!/usr/bin/env bash
# check-versions.sh — assert every version declaration in the repo agrees.
#
# Orca's version is written down in nine places (three Cargo manifests, three
# npm manifests plus their lockfiles, the Tauri config, the F-Droid recipe) and
# is *derived* into two more (the Android versionCode, the fastlane changelog
# filename). A release that disagrees with itself fails late and confusingly:
# `release.yml` refuses the tag, or Play silently ships last release's
# "what's new". This script is the one gate that catches it early — CI runs it
# on every push, and scripts/release.zsh runs it after bumping.
#
# The canonical version is app/src-tauri/tauri.conf.json: it is what tauri-cli
# turns into the Android versionName/versionCode, so it is the value with real
# downstream consequences. Everything else must match it.
#
# Usage:
#   scripts/check-versions.sh            # internal consistency only
#   scripts/check-versions.sh v0.1.0     # also require the version to be 0.1.0
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

FDROID_RECIPE="packaging/fdroid/com.meeks233.orca.yml"
LOCALES=(en-US zh-CN)

fail_count=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail_count=$((fail_count + 1)); }

json_version() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$1"; }

# `version = "X"` from the [package] table — the first such key in the file.
toml_version() { sed -n '/^\[package\]/,/^\[/ s/^version *= *"\(.*\)"/\1/p' "$1" | head -n1; }

expect() { # expect <label> <actual> <wanted>
  if [ "$2" = "$3" ]; then ok "$1 = $2"; else bad "$1 = ${2:-<missing>} (expected $3)"; fi
}

VERSION="$(json_version app/src-tauri/tauri.conf.json)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { printf '\033[31merror:\033[0m tauri.conf.json version %q is not MAJOR.MINOR.PATCH\n' "$VERSION" >&2; exit 1; }

IFS=. read -r MAJOR MINOR PATCH <<<"$VERSION"
# Mirrors tauri-cli's mapping, and release.yml's changelog lookup.
CODE=$((MAJOR * 1000000 + MINOR * 1000 + PATCH))

printf '\033[36m==> Orca version consistency (canonical %s, versionCode %s)\033[0m\n' "$VERSION" "$CODE"

expect "Cargo.toml"                  "$(toml_version Cargo.toml)"                  "$VERSION"
expect "app/src-tauri/Cargo.toml"    "$(toml_version app/src-tauri/Cargo.toml)"    "$VERSION"
expect "frontend/package.json"       "$(json_version frontend/package.json)"       "$VERSION"
expect "frontend/package-lock.json"  "$(json_version frontend/package-lock.json)"  "$VERSION"
expect "extension/package.json"      "$(json_version extension/package.json)"      "$VERSION"
expect "extension/package-lock.json" "$(json_version extension/package-lock.json)" "$VERSION"

# Lockfiles carry the root version twice: top level and packages[""].
for lock in frontend/package-lock.json extension/package-lock.json; do
  expect "$lock packages[\"\"]" \
    "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["packages"][""]["version"])' "$lock")" \
    "$VERSION"
done

# Cargo.lock pins the workspace crates' own versions; a bump that skips it makes
# every `--locked` build in CI fail with a lockfile-out-of-date error.
for crate in orca orca-app; do
  expect "Cargo.lock ($crate)" \
    "$(awk -v c="$crate" '/^\[\[package\]\]/{n=""} /^name = /{gsub(/"/,"");n=$3} /^version = /{gsub(/"/,""); if(n==c){print $3; exit}}' \
       "$([ "$crate" = orca ] && echo Cargo.lock || echo app/src-tauri/Cargo.lock)")" \
    "$VERSION"
done

# F-Droid builds from a tag, so its recipe must name this exact release.
expect "$FDROID_RECIPE CurrentVersion" \
  "$(sed -n 's/^CurrentVersion: *//p' "$FDROID_RECIPE")" "$VERSION"
expect "$FDROID_RECIPE CurrentVersionCode" \
  "$(sed -n 's/^CurrentVersionCode: *//p' "$FDROID_RECIPE")" "$CODE"

if grep -q "^  - versionName: $VERSION\$" "$FDROID_RECIPE" \
   && grep -q "^    versionCode: $CODE\$" "$FDROID_RECIPE" \
   && grep -q "^    commit: v$VERSION\$" "$FDROID_RECIPE"; then
  ok "$FDROID_RECIPE has a Builds entry for $VERSION / $CODE / v$VERSION"
else
  bad "$FDROID_RECIPE is missing a Builds entry for versionName $VERSION, versionCode $CODE, commit v$VERSION"
fi

# Play's "what's new" comes from these files and nowhere else; a missing one
# fails the release job, so catch it here instead.
for loc in "${LOCALES[@]}"; do
  f="fastlane/metadata/android/$loc/changelogs/$CODE.txt"
  if [ -s "$f" ]; then ok "$f"; else bad "$f is missing or empty"; fi
done

if [ $# -ge 1 ]; then
  expect "requested release tag" "v$VERSION" "${1#refs/tags/}"
fi

if [ "$fail_count" -ne 0 ]; then
  printf '\033[31m%d version declaration(s) disagree.\033[0m Run scripts/release.zsh to bump them together.\n' "$fail_count" >&2
  exit 1
fi
printf '\033[32mAll version declarations agree on %s.\033[0m\n' "$VERSION"
