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
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub download_dir: PathBuf,
    pub concurrency: usize,
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
        let token = env_opt("WHALE_TOKEN")
            .ok_or_else(|| anyhow!("WHALE_TOKEN is required and must be non-empty"))?;

        let bind: SocketAddr = env_or("WHALE_BIND", "0.0.0.0:8080")
            .parse()
            .context("WHALE_BIND must be a valid socket address")?;

        let data_dir = PathBuf::from(env_or("WHALE_DATA_DIR", "/data"));
        let download_dir = PathBuf::from(env_or("WHALE_DOWNLOAD_DIR", "/downloads"));

        let concurrency: usize = env_or("WHALE_CONCURRENCY", "2")
            .parse()
            .context("WHALE_CONCURRENCY must be a positive integer")?;

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
            bind,
            data_dir,
            download_dir,
            concurrency,
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
}
