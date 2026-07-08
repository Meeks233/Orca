//! In-memory dedup set backed by an append-only yt-dlp `--download-archive` file.
//! Workstream B owns this file. See docs/MODULES.md §3, docs/DATABASE.md §3.

use std::path::Path;

#[derive(Clone)]
pub struct Archive {
    #[allow(dead_code)]
    inner: std::sync::Arc<Inner>,
}

struct Inner {
    #[allow(dead_code)]
    set: tokio::sync::Mutex<std::collections::HashSet<String>>,
    #[allow(dead_code)]
    path: std::path::PathBuf,
}

impl Archive {
    pub async fn load(_path: &Path, _seed: Vec<String>) -> anyhow::Result<Self> {
        todo!("workstream B: union seed with archive.txt, rewrite if differ")
    }

    pub async fn contains(&self, _key: &str) -> bool {
        todo!("workstream B")
    }

    pub async fn insert(&self, _key: &str) -> anyhow::Result<()> {
        todo!("workstream B: add to set + append file")
    }

    pub async fn remove(&self, _key: &str) -> anyhow::Result<()> {
        todo!("workstream B: remove from set + rewrite file")
    }
}
