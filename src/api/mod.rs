//! HTTP router assembly + shared state. Integration (Phase 2). See docs/API.md.

mod auth;
mod events;
mod items;

use crate::archive::Archive;
use crate::config::Config;
use crate::db::Db;
use crate::queue::Queue;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Config,
    pub db: Db,
    pub archive: Archive,
    pub queue: Queue,
    pub ytdlp_version: String,
}

pub fn router(_state: AppState) -> axum::Router {
    todo!("phase 2: assemble routes + auth middleware + static assets")
}
