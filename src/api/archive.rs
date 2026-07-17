//! Manual dedup-archive editing. See docs/API.md.
//!
//! The dedup set uses Seal's scheme — one `extractor id` key per item (same as
//! yt-dlp `--download-archive`). Ex-Seal users can view/add/remove keys here to
//! seed "already have this" state or fix mistakes, on top of the Seal-backup CLI
//! import. Adding a key makes a matching future submit dedup; removing one lets
//! it re-download.

use super::AppState;
use crate::error::{AppError, AppResult};
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
pub struct KeyRequest {
    pub key: String,
}

#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    /// Raw yt-dlp/Seal download-archive text: one `extractor id` key per line.
    pub archive: String,
}

/// GET /api/archive — list all dedup keys (sorted), and whether a previous
/// version is on disk for the editor's Restore to roll back to.
pub async fn list(State(state): State<AppState>) -> AppResult<Response> {
    Ok(Json(json!({
        "keys": state.archive.keys().await,
        "has_backup": state.archive.has_backup().await,
    }))
    .into_response())
}

/// PUT /api/archive — replace the whole archive with the editor's contents. Body
/// `{ "archive": "youtube abc123\ntwitter 456\n…" }`.
///
/// This is what the Settings editor saves: it replaces rather than merges, so a
/// deleted line actually frees the key to re-download. The previous version is
/// copied aside first — see `Archive::replace` — and `POST /api/archive/restore`
/// brings it back. Blank/malformed lines are skipped.
pub async fn replace(
    State(state): State<AppState>,
    Json(req): Json<ImportRequest>,
) -> AppResult<Response> {
    let (keys, skipped) = parse_keys(&req.archive);
    let count = state
        .archive
        .replace(keys)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "count": count, "skipped": skipped, "has_backup": true })).into_response())
}

/// POST /api/archive/restore — roll the archive back to its previous version.
/// Returns the restored keys. The version rolled back *from* becomes the new
/// backup, so this is itself undoable.
pub async fn restore(State(state): State<AppState>) -> AppResult<Response> {
    if !state.archive.has_backup().await {
        return Err(AppError::BadRequest(
            "no previous archive version to restore".into(),
        ));
    }
    let keys = state
        .archive
        .restore()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "keys": keys, "has_backup": true })).into_response())
}

/// Split archive text into valid keys, counting what was dropped. Seal/yt-dlp
/// keys are `extractor id`; anything without a space is junk.
fn parse_keys(archive: &str) -> (Vec<String>, usize) {
    let mut keys = Vec::new();
    let mut skipped = 0usize;
    for line in archive.lines() {
        let key = line.trim();
        if key.is_empty() || !key.contains(' ') {
            skipped += 1;
            continue;
        }
        keys.push(key.to_string());
    }
    (keys, skipped)
}

/// POST /api/archive — add a dedup key. Body `{ "key": "youtube abc123" }`.
/// Idempotent. Rejects keys not shaped like `extractor id`.
pub async fn add(
    State(state): State<AppState>,
    Json(req): Json<KeyRequest>,
) -> AppResult<Response> {
    let key = req.key.trim();
    if key.is_empty() || !key.contains(' ') {
        return Err(AppError::BadRequest(
            "key must look like 'extractor id' (Seal/yt-dlp archive format)".into(),
        ));
    }
    state
        .archive
        .insert(key)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "added": true, "key": key })).into_response())
}

/// POST /api/archive/import — bulk-import a Seal/yt-dlp download archive. Body
/// `{ "archive": "youtube abc123\ntwitter 456\n…" }`. Blank/malformed lines are
/// skipped; the rest seed "already have this" dedup state. Idempotent.
pub async fn import(
    State(state): State<AppState>,
    Json(req): Json<ImportRequest>,
) -> AppResult<Response> {
    let (keys, skipped) = parse_keys(&req.archive);
    let added = keys.len();
    for key in keys {
        state
            .archive
            .insert(&key)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    }
    Ok(Json(json!({ "added": added, "skipped": skipped })).into_response())
}

/// DELETE /api/archive — remove a dedup key. Body `{ "key": "youtube abc123" }`.
pub async fn remove(
    State(state): State<AppState>,
    Json(req): Json<KeyRequest>,
) -> AppResult<Response> {
    let key = req.key.trim();
    state
        .archive
        .remove(key)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "removed": true, "key": key })).into_response())
}
