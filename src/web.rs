//! Embedded static frontend assets (rust-embed). Integration (Phase 2). See docs/FRONTEND.md.

#![allow(dead_code)]

use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "web/"]
pub struct Assets;

/// Look up an embedded asset by path (e.g. "index.html", "app.js").
pub fn get(path: &str) -> Option<rust_embed::EmbeddedFile> {
    Assets::get(path)
}
