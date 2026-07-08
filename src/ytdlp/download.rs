//! yt-dlp download with progress parsing. Workstream E owns this file.
//! See docs/DOWNLOAD_PIPELINE.md §2–§3.

use super::YtdlpError;
use crate::config::Config;
use crate::types::{Item, ProgressEvent};
use tokio::sync::mpsc;

pub struct DownloadOutcome {
    pub filepath: String,
    pub filesize: i64,
}

/// Run a download for `item`. Progress ticks are sent on `progress` as they are
/// parsed from yt-dlp's stdout; the final outcome resolves when the process exits.
pub async fn download(
    _cfg: &Config,
    _item: &Item,
    _progress: mpsc::Sender<ProgressEvent>,
) -> Result<DownloadOutcome, YtdlpError> {
    todo!("workstream E")
}
