//! Live-terminal counter. See docs/API.md (`429 terminal_limit`).
//!
//! A *terminal* is one open client surface — a browser tab, or the app. Each one
//! holds an SSE stream (`/api/events`) open for as long as it exists, and a
//! browser allows only six concurrent connections per origin: once enough tabs
//! are open, a newly opened one has no connection left, so every request it makes
//! queues forever and the page just sits there showing nothing — a silent
//! failure with nothing on screen to explain it.
//!
//! So the server counts terminals and serves a fixed number of them at once, one
//! below that browser ceiling. The spare connection is the whole point: it lets
//! an over-limit terminal's heartbeat still get through and be answered with
//! `429`, which is what the client turns into "close this tab".
//!
//! Terminals identify themselves with an opaque per-page id (`X-Orca-Term` on the
//! heartbeat, `?term=` on the stream). Everything here is in-memory and
//! self-pruning; a client that sends no id is not counted and never refused.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Header the heartbeat (`GET /api/stats`) carries its terminal id in.
pub const HEADER: &str = "X-Orca-Term";

/// One below the browsers' six-connections-per-origin limit, so an over-limit
/// terminal still has a connection to run its heartbeat on.
const MAX_TERMINALS: usize = 5;

/// A terminal holding no stream is forgotten this long after it was last heard
/// from, which is what hands a closed page's slot to the next one. Longer than
/// the client's 10s heartbeat (so a live page never loses its own slot) and short
/// enough that closing a tab visibly releases it.
const IDLE_TTL_SECS: i64 = 15;

struct Entry {
    /// Open SSE streams. Non-zero pins the terminal regardless of `last`: a
    /// backgrounded tab stops heartbeating but still holds its connection.
    streams: usize,
    last: i64,
}

/// Cloneable handle to the in-memory terminal table.
#[derive(Clone, Default)]
pub struct Terminals(Arc<Mutex<HashMap<String, Entry>>>);

impl Terminals {
    /// Register or refresh a terminal from its heartbeat. `false` means the
    /// server is already serving `MAX_TERMINALS` *other* terminals — the caller
    /// answers `429` and the client asks the user to close this page.
    pub fn touch(&self, id: &str) -> bool {
        self.touch_at(id, crate::types::now_unix())
    }

    fn touch_at(&self, id: &str, now: i64) -> bool {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut map, now);
        if let Some(entry) = map.get_mut(id) {
            entry.last = now;
            return true;
        }
        if map.len() >= MAX_TERMINALS {
            return false;
        }
        map.insert(
            id.to_string(),
            Entry {
                streams: 0,
                last: now,
            },
        );
        true
    }

    /// Claim a slot for an SSE stream, held until the returned guard drops.
    /// `None` when the cap is reached — the caller must answer immediately rather
    /// than hold open a connection this terminal isn't allowed to have.
    pub fn open_stream(&self, id: &str) -> Option<StreamGuard> {
        self.open_stream_at(id, crate::types::now_unix())
    }

    fn open_stream_at(&self, id: &str, now: i64) -> Option<StreamGuard> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut map, now);
        if !map.contains_key(id) && map.len() >= MAX_TERMINALS {
            return None;
        }
        let entry = map.entry(id.to_string()).or_insert(Entry {
            streams: 0,
            last: now,
        });
        entry.streams += 1;
        entry.last = now;
        Some(StreamGuard {
            store: self.clone(),
            id: id.to_string(),
        })
    }
}

/// Holds a terminal's slot for the lifetime of one SSE stream.
pub struct StreamGuard {
    store: Terminals,
    id: String,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let now = crate::types::now_unix();
        let mut map = self.store.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(&self.id) {
            entry.streams = entry.streams.saturating_sub(1);
            // Start the idle clock from the disconnect, not the last heartbeat.
            entry.last = now;
        }
    }
}

/// Drop terminals that hold no stream and haven't been heard from. Called on
/// every access, so a closed page's slot frees itself.
fn prune(map: &mut HashMap<String, Entry>, now: i64) {
    map.retain(|_, e| e.streams > 0 || now - e.last <= IDLE_TTL_SECS);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_only_terminals_past_the_cap() {
        let terminals = Terminals::default();
        let now = crate::types::now_unix();
        for i in 0..MAX_TERMINALS {
            assert!(terminals.touch_at(&format!("t{i}"), now));
        }
        assert!(!terminals.touch_at("one-too-many", now));
        // A terminal already counted keeps being served.
        assert!(terminals.touch_at("t0", now));
    }

    #[test]
    fn a_stream_holds_its_slot_while_open_and_frees_it_once_closed() {
        let terminals = Terminals::default();
        // Real time, because `Drop` stamps the disconnect with the wall clock.
        let now = crate::types::now_unix();
        let guards: Vec<_> = (0..MAX_TERMINALS)
            .map(|i| terminals.open_stream_at(&format!("t{i}"), now).unwrap())
            .collect();
        assert!(terminals.open_stream_at("new-tab", now).is_none());
        // A stream pins its terminal even after the heartbeats stop.
        assert!(!terminals.touch_at("new-tab", now + IDLE_TTL_SECS * 10));
        // Closing them starts the idle clock; past it the slots are handed on.
        drop(guards);
        assert!(!terminals.touch_at("new-tab", now + IDLE_TTL_SECS));
        assert!(terminals.touch_at("new-tab", now + IDLE_TTL_SECS + 2));
    }
}
