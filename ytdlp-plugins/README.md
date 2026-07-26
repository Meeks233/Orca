# yt-dlp extractor plugins

Extractors Orca ships for sites upstream yt-dlp doesn't handle.

Layout follows yt-dlp's plugin convention — `<package>/yt_dlp_plugins/extractor/*.py`.
The Dockerfile copies this directory to `~/.config/yt-dlp/plugins/`, which yt-dlp
scans automatically, so no `--plugin-dirs` flag appears on any command line.

| Plugin | Sites | Why |
| --- | --- | --- |
| `orca/.../e621.py` | e621.net, e926.net, e6ai.net | The post page builds its player in JS, so the generic extractor fails with `Unsupported URL`. The plugin reads `/posts/<id>.json` and reports one format per transcode the site holds (480p / 720p / full-size mp4 / original), which is what gives the resolution picker a real ladder. |
| `orca/.../twitter_images.py` | x.com, twitter.com | Upstream's Twitter extractor intentionally omits static `photo` media. This subclass emits the original image as a yt-dlp format while retaining upstream's CookieJar, login, UA and API selection, so photo posts use the same authenticated path as videos. |

To test a change against the running dev container without a full rebuild:

```sh
docker cp ytdlp-plugins/orca orca-dev:/home/orca/.config/yt-dlp/plugins/orca
docker exec orca-dev yt-dlp -F 'https://e621.net/posts/6564391'
```
