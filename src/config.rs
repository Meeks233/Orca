//! Configuration loaded from environment variables. See docs/CONFIG.md.

use anyhow::{anyhow, Context};
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Mkv,
    Mp4,
}

impl Container {
    pub fn ext(&self) -> &'static str {
        match self {
            Container::Mkv => "mkv",
            Container::Mp4 => "mp4",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub token: String,
    /// True when `token` was randomly generated because `WHALE_TOKEN` was unset.
    pub token_generated: bool,
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub download_dir: PathBuf,
    pub concurrency: usize,
    /// yt-dlp `--concurrent-fragments` (multi-threaded fragment download).
    pub concurrent_fragments: usize,
    /// Total download-rate cap (e.g. `"10M"`), split across `concurrency` jobs.
    /// `None` disables rate limiting.
    pub limit_rate: Option<String>,
    pub container: Container,
    pub output_template: String,
    pub format: String,
    pub subs: bool,
    pub auto_subs: bool,
    pub sub_langs: String,
    pub embed_thumbnail: bool,
    pub cookies: Option<PathBuf>,
    pub ytdlp_path: String,
    pub ffmpeg_location: Option<PathBuf>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_bool(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(v) => matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        Err(_) => default,
    }
}

fn env_opt(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let (token, token_generated) = match env_opt("WHALE_TOKEN") {
            Some(t) => (t, false),
            None => (random_token()?, true),
        };

        let bind: SocketAddr = env_or("WHALE_BIND", "0.0.0.0:8080")
            .parse()
            .context("WHALE_BIND must be a valid socket address")?;

        let data_dir = PathBuf::from(env_or("WHALE_DATA_DIR", "/data"));
        let download_dir = PathBuf::from(env_or("WHALE_DOWNLOAD_DIR", "/downloads"));

        let concurrency: usize = env_or("WHALE_CONCURRENCY", "2")
            .parse()
            .context("WHALE_CONCURRENCY must be a positive integer")?;

        let concurrent_fragments: usize = env_or("WHALE_CONCURRENT_FRAGMENTS", "4")
            .parse()
            .context("WHALE_CONCURRENT_FRAGMENTS must be a positive integer")?;

        // Total rate cap across all concurrent jobs; empty/"0"/"none" disables it.
        let limit_rate = match env_opt("WHALE_LIMIT_RATE") {
            None => Some("10M".to_string()),
            Some(v) => match v.trim().to_ascii_lowercase().as_str() {
                "0" | "none" | "off" | "unlimited" => None,
                _ => Some(v.trim().to_string()),
            },
        };

        let container = match env_or("WHALE_CONTAINER", "mkv").to_ascii_lowercase().as_str() {
            "mkv" => Container::Mkv,
            "mp4" => Container::Mp4,
            other => {
                return Err(anyhow!(
                    "WHALE_CONTAINER '{other}' is invalid; valid options: mkv, mp4"
                ))
            }
        };

        let output_template = env_or(
            "WHALE_OUTPUT_TEMPLATE",
            "%(uploader,channel|Unknown)s - %(title).150B [%(id)s].%(ext)s",
        );
        let format = env_or("WHALE_FORMAT", "bv*+ba/b");
        let subs = env_bool("WHALE_SUBS", true);
        let auto_subs = env_bool("WHALE_AUTO_SUBS", false);
        let sub_langs = env_or("WHALE_SUB_LANGS", "all,-live_chat");
        let embed_thumbnail = env_bool("WHALE_EMBED_THUMBNAIL", true);
        let cookies = env_opt("WHALE_COOKIES").map(PathBuf::from);
        let ytdlp_path = env_or("WHALE_YTDLP_PATH", "yt-dlp");
        let ffmpeg_location = env_opt("WHALE_FFMPEG_LOCATION").map(PathBuf::from);

        Ok(Config {
            token,
            token_generated,
            bind,
            data_dir,
            download_dir,
            concurrency,
            concurrent_fragments,
            limit_rate,
            container,
            output_template,
            format,
            subs,
            auto_subs,
            sub_langs,
            embed_thumbnail,
            cookies,
            ytdlp_path,
            ffmpeg_location,
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("whale.db")
    }

    pub fn archive_path(&self) -> PathBuf {
        self.data_dir.join("archive.txt")
    }

    /// Per-job `--limit-rate` value in bytes/s: the configured total cap divided
    /// across `concurrency` jobs so their combined throughput stays under it.
    /// Returns `None` if rate limiting is disabled or the value is unparseable.
    pub fn per_job_limit_rate(&self) -> Option<String> {
        let total = parse_rate(self.limit_rate.as_deref()?)?;
        let per = total / (self.concurrency.max(1) as u64);
        Some(per.max(1).to_string())
    }
}

/// Parse a human rate string (`"10M"`, `"500K"`, `"1.5MiB"`, `"1048576"`) into
/// bytes/second. K/M/G are treated as binary (1024) multiples, matching yt-dlp.
fn parse_rate(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let digits_end = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(s.len());
    let (num, suffix) = s.split_at(digits_end);
    let value: f64 = num.parse().ok()?;
    let mult: f64 = match suffix.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1.0,
        "k" | "kb" | "kib" => 1024.0,
        "m" | "mb" | "mib" => 1024.0 * 1024.0,
        "g" | "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * mult) as u64)
}

/// Generate a 32-character (128-bit) hex token from OS randomness.
fn random_token() -> anyhow::Result<String> {
    let mut bytes = [0u8; 16];
    let mut f =
        std::fs::File::open("/dev/urandom").context("cannot open /dev/urandom to generate token")?;
    std::io::Read::read_exact(&mut f, &mut bytes)
        .context("cannot read randomness for token generation")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rate_handles_suffixes() {
        assert_eq!(parse_rate("10M"), Some(10 * 1024 * 1024));
        assert_eq!(parse_rate("500K"), Some(500 * 1024));
        assert_eq!(parse_rate("1048576"), Some(1048576));
        assert_eq!(parse_rate("1.5MiB"), Some((1.5 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_rate("garbage"), None);
    }

    #[test]
    fn random_token_is_32_hex_chars() {
        let t = random_token().unwrap();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, random_token().unwrap());
    }
}
