"""yt-dlp extractor plugin for e621 / e926 / e6ai video posts.

Upstream yt-dlp has no e621 extractor and its generic extractor bails with
"Unsupported URL" on a post page (the player is built by JS), so Orca could
neither probe nor download these. The site exposes the whole post as JSON at
`/posts/<id>.json`, including every transcode it holds, so this extractor reads
that and reports one format per variant. That is what gives Orca a real
resolution ladder for e621 — the picker, the auto-selected default and the
`-f` height cap all work off `formats[].height`.

Installed into the image at ~/.config/yt-dlp/plugins/orca (auto-loaded, no
yt-dlp flag needed); see the Dockerfile.
"""

from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import (
    ExtractorError,
    float_or_none,
    int_or_none,
    str_or_none,
    unified_timestamp,
    url_or_none,
)
from yt_dlp.utils.traversal import traverse_obj

# e621's API terms ask for a descriptive User-Agent; a bare python/urllib one is
# rejected outright with 403.
_UA = 'Orca/1.0 (self-hosted yt-dlp downloader; +https://github.com/Meeks233/Orca)'


# Tags the site files under `artist` that name nobody — warnings and status
# markers. Left in, a post credits itself to "conditional_dnp, sound_warning,
# zackary911", which is then also the filename.
_NON_ARTIST_TAGS = {
    'anonymous_artist', 'avoid_posting', 'conditional_dnp', 'epilepsy_warning',
    'sound_edit', 'sound_warning', 'third-party_edit', 'unknown_artist',
    'unknown_artist_signature',
}


class E621IE(InfoExtractor):
    IE_NAME = 'e621'
    IE_DESC = 'e621 / e926 / e6ai posts'
    _VALID_URL = r'https?://(?:www\.)?(?P<host>e621\.net|e926\.net|e6ai\.net)/posts?/(?P<id>\d+)'
    _TESTS = [{
        'url': 'https://e621.net/posts/6564391',
        'only_matching': True,
    }]

    def _format(self, source, format_id, ext=None):
        url = url_or_none(traverse_obj(source, 'url'))
        if not url:
            return None
        return {
            'url': url,
            'format_id': format_id,
            'ext': ext or traverse_obj(source, 'ext') or 'mp4',
            # Codecs are deliberately left unreported. The API names the video
            # codec but never the audio one, and a format with a known vcodec and
            # an unknown acodec makes `bv*+ba` try to merge two copies of the same
            # progressive file. Leaving both unknown keeps the selector on the
            # `/b` branch, which is what these single-file transcodes are.
            'width': int_or_none(traverse_obj(source, 'width')),
            'height': int_or_none(traverse_obj(source, 'height')),
            'filesize': int_or_none(traverse_obj(source, 'size')),
            'fps': float_or_none(traverse_obj(source, 'fps')),
            'http_headers': {'User-Agent': _UA},
        }

    def _real_extract(self, url):
        host, post_id = self._match_valid_url(url).group('host', 'id')
        post = self._download_json(
            f'https://{host}/posts/{post_id}.json', post_id,
            note='Downloading post JSON', headers={'User-Agent': _UA})['post']

        file_info = post.get('file') or {}
        alternates = traverse_obj(post, ('sample', 'alternates')) or {}

        formats = []
        # The original upload — webm/mp4 at full resolution, the best copy there is.
        original = self._format(
            alternates.get('original') or file_info, 'original', file_info.get('ext'))
        if original:
            formats.append(original)
        # Re-encodes: an H.264 mp4 at full size, plus the 480p/720p ladder. The
        # site's labels are nominal ("720p" is 810px tall on a 1511x850 sample),
        # so the real pixel height from the JSON is what we report.
        for name, variant in (alternates.get('variants') or {}).items():
            fmt = self._format(variant, f'alt-{name}', name if name in ('mp4', 'webm') else None)
            if fmt:
                formats.append(fmt)
        for name, sample in (alternates.get('samples') or {}).items():
            fmt = self._format(sample, name, 'mp4')
            if fmt:
                formats.append(fmt)

        if not formats:
            # Two very different causes, one symptom: an image-only post has no
            # video at all, while a post tagged with something the site hides from
            # anonymous visitors comes back complete except that every `url` is
            # null. Say so, because the second one is fixed by adding cookies for
            # e621 in Orca's site settings and the first one never will be.
            is_video = file_info.get('ext') in ('webm', 'mp4')
            raise ExtractorError(
                f'Post {post_id} is a {file_info.get("ext") or "non-video"} post, not a video'
                if not is_video else
                f'Post {post_id} exposes no video URL — the site withholds file URLs for '
                'this post from anonymous visitors; add e621 cookies in Orca and retry',
                expected=True)

        artists = [
            t for t in (traverse_obj(post, ('tags', 'artist')) or [])
            if t not in _NON_ARTIST_TAGS
        ]
        # Posts carry no title of their own, and the description is the artist's
        # free-form blurb (often a Patreon plug), so name the post the way the site
        # itself refers to it: artist(s) plus the post id.
        description = (post.get('description') or '').strip()
        title = f'{", ".join(artists) or host} - {post_id}'

        return {
            'id': post_id,
            'title': title,
            'description': description or None,
            'formats': formats,
            'duration': float_or_none(post.get('duration')),
            'thumbnail': url_or_none(traverse_obj(post, ('sample', 'url')))
            or url_or_none(traverse_obj(post, ('preview', 'url'))),
            'uploader': ', '.join(artists) or post.get('uploader_name'),
            'uploader_id': str_or_none(post.get('uploader_id')),
            'timestamp': unified_timestamp(post.get('created_at')),
            'tags': [t for group in (post.get('tags') or {}).values() for t in group],
            'age_limit': 0 if host == 'e926.net' else 18,
            'webpage_url': f'https://{host}/posts/{post_id}',
        }
