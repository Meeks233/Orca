//! Build yt-dlp argument vectors from Config. Workstream C owns this file.
//! See docs/DOWNLOAD_PIPELINE.md §1–§2.

use crate::config::Config;
use crate::types::Item;

/// Args for the metadata probe (`yt-dlp --dump-json --skip-download ...`).
pub fn probe_args(_cfg: &Config, _url: &str) -> Vec<String> {
    todo!("workstream C")
}

/// Args for a download run.
pub fn download_args(_cfg: &Config, _item: &Item) -> Vec<String> {
    todo!("workstream C")
}
