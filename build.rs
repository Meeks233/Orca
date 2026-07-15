//! Force a recompile (and therefore a rust-embed re-embed of `web/`) whenever a
//! frontend asset changes. `#[derive(RustEmbed)]` bakes `web/` into the binary at
//! compile time, but Cargo doesn't treat those files as inputs — so a
//! frontend-only edit would otherwise be a cache hit and ship stale assets.
//! Watching the directory here is the canonical fix (see rust-embed docs).
fn main() {
    println!("cargo:rerun-if-changed=web");
}
