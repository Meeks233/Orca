//! In-memory ring buffer of recent operational errors (probe / download
//! failures) surfaced to the UI's diagnostics panel via `GET /api/logs`.
//!
//! Deliberately tiny and bounded: at most `CAPACITY` entries are retained, so it
//! can never grow unbounded on a long-lived server. Oldest entries are evicted
//! first; the API returns them newest-first. This complements — it does not
//! replace — the structured `tracing` logs, which remain the source of truth for
//! server-side debugging.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// Most recent errors to retain (the goal: "record at most 90 error entries").
pub const CAPACITY: usize = 90;

/// One recorded failure, shaped for direct JSON serialization to the UI.
#[derive(Clone, serde::Serialize)]
pub struct ErrorEntry {
    /// Unix seconds when the error was recorded.
    pub at: i64,
    /// Where it happened: `"probe"` (submit-time metadata read) or `"download"`.
    pub stage: &'static str,
    /// The URL involved (the canonicalized `webpage_url`).
    pub url: String,
    /// Detected platform key (e.g. `"twitter"`), or `"unknown"`.
    pub platform: String,
    /// The user-facing (already enriched) error message.
    pub message: String,
}

/// A cheaply-cloneable handle to the shared ring buffer.
#[derive(Clone)]
pub struct ErrorLog {
    inner: Arc<Mutex<VecDeque<ErrorEntry>>>,
}

impl ErrorLog {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(CAPACITY))),
        }
    }

    /// Record one error, evicting the oldest when already at capacity.
    pub fn push(&self, stage: &'static str, url: &str, platform: &str, message: &str) {
        let entry = ErrorEntry {
            at: crate::types::now_unix(),
            stage,
            url: url.to_string(),
            platform: platform.to_string(),
            message: message.to_string(),
        };
        // Tolerate a poisoned lock: a panic elsewhere must not wedge error
        // recording (these critical sections are trivial and never panic).
        let mut q = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        while q.len() >= CAPACITY {
            q.pop_front();
        }
        q.push_back(entry);
    }

    /// Snapshot of all retained entries, newest first, for the API.
    pub fn snapshot(&self) -> Vec<ErrorEntry> {
        let q = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        q.iter().rev().cloned().collect()
    }
}

impl Default for ErrorLog {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_oldest_beyond_capacity() {
        let log = ErrorLog::new();
        for i in 0..(CAPACITY + 5) {
            log.push("probe", &format!("https://x.com/{i}"), "twitter", "boom");
        }
        let snap = log.snapshot();
        assert_eq!(snap.len(), CAPACITY);
        // Newest-first: the last pushed URL is at the front.
        assert_eq!(snap[0].url, format!("https://x.com/{}", CAPACITY + 4));
        // The oldest 5 were evicted; entry #5 is now the tail.
        assert_eq!(snap.last().unwrap().url, "https://x.com/5");
    }

    #[test]
    fn snapshot_is_newest_first() {
        let log = ErrorLog::new();
        log.push("probe", "a", "twitter", "first");
        log.push("download", "b", "youtube", "second");
        let snap = log.snapshot();
        assert_eq!(snap[0].message, "second");
        assert_eq!(snap[1].message, "first");
    }
}
