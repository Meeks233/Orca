//! Bearer-token auth middleware. Integration (Phase 2). See docs/API.md.

#![allow(dead_code)]

/// Extract a bearer token from the `Authorization` header or `?token=` query.
pub fn extract_token(_headers: &axum::http::HeaderMap, _query: &str) -> Option<String> {
    todo!("phase 2")
}
