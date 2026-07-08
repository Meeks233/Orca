//! Download worker: semaphore-bounded job loop + SSE broadcast. Integration (Phase 2).
//! See docs/DOWNLOAD_PIPELINE.md §4.

use crate::archive::Archive;
use crate::config::Config;
use crate::db::Db;
use crate::types::ProgressEvent;
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct Queue {
    tx: tokio::sync::mpsc::UnboundedSender<i64>,
    events: broadcast::Sender<ProgressEvent>,
}

impl Queue {
    pub fn spawn(_cfg: Config, _db: Db, _archive: Archive) -> Self {
        todo!("phase 2: start worker loop")
    }

    pub async fn enqueue(&self, item_id: i64) {
        let _ = self.tx.send(item_id);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ProgressEvent> {
        self.events.subscribe()
    }
}
