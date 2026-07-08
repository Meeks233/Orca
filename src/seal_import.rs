//! Seal backup parser + importer. Workstream H owns this file. See docs/SEAL_IMPORT.md.

use crate::archive::Archive;
use crate::config::Config;
use crate::db::Db;
use std::path::Path;

/// One parsed Seal history record.
#[derive(Debug, Clone)]
pub struct SealRecord {
    pub title: String,
    pub author: Option<String>,
    pub url: String,
    pub path: String,
    pub extractor: String,
    /// Derived from `[id]` in the path, else a URL pattern, else None.
    pub video_id: Option<String>,
}

/// Result of importing a Seal record (per-record) or a whole run (aggregated).
#[derive(Debug, Clone, Copy, Default)]
pub struct ImportOutcome {
    pub imported: u64,
    pub skipped_dupes: u64,
    pub unparsable: u64,
}

pub async fn run_import(
    _cfg: &Config,
    _db: &Db,
    _archive: &Archive,
    _file: &Path,
    _archive_only: bool,
) -> anyhow::Result<ImportOutcome> {
    todo!("workstream H")
}
