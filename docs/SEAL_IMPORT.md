# Seal import

Import an existing Seal backup so previously-downloaded media is recorded in Whale and
**dedups** against future submits.

## 1. Command

```
whale import [--archive-only] <seal-backup.json>
```
Inside Docker:
```
docker exec whale whale import /data/seal-backup.json
```
(Drop the backup into the mounted data volume, then run the command.)

Flags:
- `--archive-only` — only append `archive_key`s to `archive.txt` + minimal rows; skip storing
  full metadata. (Faster, smaller; history view will be sparse.) Default is full import.

Prints an `ImportOutcome` summary: `imported`, `skipped_dupes`, `unparsable`.

## 2. Seal backup format (verified against Seal source)

Seal's backup JSON (`BackupUtil.kt` → `Backup`) wraps history under `downloadHistory`:
```json
{
  "downloadHistory": [
    {
      "id": 1,
      "videoTitle": "…",
      "videoAuthor": "…",
      "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "thumbnailUrl": "…",
      "videoPath": "/storage/emulated/0/Download/Some Title [dQw4w9WgXcQ].mkv",
      "extractor": "youtube"
    }
  ],
  "templates": [ … ],   // ignored
  "shortcuts": [ … ]    // ignored
}
```
Fields we use per entry (`DownloadedVideoInfo`): `videoTitle`, `videoAuthor`, `videoUrl`,
`thumbnailUrl`, `videoPath`, `extractor`.

> ⚠️ **Seal does not store the yt-dlp `id`.** We must derive it. Also accept the plain
> **URL-list** export (newline-separated `videoUrl`s) — detect by "not JSON" and treat each
> line as a `videoUrl` with empty metadata.

## 3. Deriving `video_id` and `archive_key`

Per entry, in order:
1. **From filename** — parse the last `[...]` token in `basename(videoPath)` (Seal's default
   template ends with `[%(id)s].%(ext)s`). Regex: `\[([^\[\]]+)\]\.[^.]+$`. That capture = `id`.
2. **From URL** — if no `[id]` (e.g. user changed template, or URL-list import), parse known
   patterns: YouTube `v=` / `youtu.be/<id>` / `shorts/<id>`; otherwise take the last non-empty
   path segment. Best-effort.
3. Normalize the extractor to lowercase (Seal already stores `"youtube"` etc.; map a few
   display-name quirks if found, e.g. `"YouTube"` → `youtube`).

Then `archive_key = "{extractor} {video_id}"` — identical namespace to yt-dlp and Whale.

- If a `video_id` was found: full dedup works. Insert row (`source = 'seal-import'`,
  `status = 'completed'`, `filepath = videoPath`), append `archive_key`.
- If **not** found (unparsable): count as `unparsable`. Fallback = synthetic key
  `"{extractor} url:{normalized_url}"` so the record still appears in history; note in the
  summary that these won't dedup a variant re-submit (documented limitation, DATABASE.md §3).

## 4. Idempotency & merge semantics

- Import is **idempotent**: run it repeatedly, existing `archive_key`s are skipped
  (`skipped_dupes`), driven by the same UNIQUE index and in-memory set.
- Import merges into an existing Whale DB (doesn't wipe). Imported rows are marked
  `source = 'seal-import'` so they're distinguishable in the UI.
- `db.upsert_import(SealRecord) -> ImportOutcome` does the insert-or-skip; `run_import`
  streams the JSON (serde `Deserializer::from_reader` over `downloadHistory`) to avoid loading
  a huge backup fully into memory, and batches archive appends.

## 5. Import as an HTTP endpoint? (out of scope v1)

Keep import CLI-only for v1 (simpler, no large-upload handling, runs where the volume lives).
An optional `POST /api/import` (multipart) can be added later; not part of the frozen contract.
