//! yt-dlp metadata probe. Workstream D owns this file. See docs/DOWNLOAD_PIPELINE.md §1.

use super::YtdlpError;
use crate::config::Config;
use crate::types::ProbeResult;

/// Probe a URL; returns one ProbeResult per video (playlists → many).
pub async fn probe(_cfg: &Config, _url: &str) -> Result<Vec<ProbeResult>, YtdlpError> {
    todo!("workstream D")
}
