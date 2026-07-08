//! SQL query implementations. Workstream A owns this file. See docs/DATABASE.md.

use super::{Db, ListPage, ListQuery};
use crate::seal_import::{ImportOutcome, SealRecord};
use crate::types::{Item, ProbeResult, Source, Status};
use std::path::Path;

pub(super) async fn connect(_data_dir: &Path) -> anyhow::Result<Db> {
    todo!("workstream A: open sqlite pool + run migrations")
}

pub(super) async fn insert_probe(
    _db: &Db,
    _p: &ProbeResult,
    _source: Source,
) -> anyhow::Result<Item> {
    todo!("workstream A")
}

pub(super) async fn find_by_archive_key(_db: &Db, _key: &str) -> anyhow::Result<Option<Item>> {
    todo!("workstream A")
}

pub(super) async fn set_status(
    _db: &Db,
    _id: i64,
    _status: Status,
    _err: Option<&str>,
) -> anyhow::Result<()> {
    todo!("workstream A")
}

pub(super) async fn set_completed(
    _db: &Db,
    _id: i64,
    _path: &str,
    _size: i64,
) -> anyhow::Result<()> {
    todo!("workstream A")
}

pub(super) async fn get(_db: &Db, _id: i64) -> anyhow::Result<Option<Item>> {
    todo!("workstream A")
}

pub(super) async fn list(_db: &Db, _q: ListQuery) -> anyhow::Result<ListPage> {
    todo!("workstream A")
}

pub(super) async fn delete(_db: &Db, _id: i64) -> anyhow::Result<Option<Item>> {
    todo!("workstream A")
}

pub(super) async fn reset_running_to_queued(_db: &Db) -> anyhow::Result<Vec<i64>> {
    todo!("workstream A")
}

pub(super) async fn all_archive_keys(_db: &Db) -> anyhow::Result<Vec<String>> {
    todo!("workstream A")
}

pub(super) async fn upsert_import(_db: &Db, _rec: SealRecord) -> anyhow::Result<ImportOutcome> {
    todo!("workstream A")
}
