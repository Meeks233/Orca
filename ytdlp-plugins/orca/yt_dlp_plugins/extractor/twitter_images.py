"""Make X/Twitter's static-photo posts downloadable through yt-dlp.

yt-dlp's built-in TwitterIE intentionally filters ``type == 'photo'`` and then
raises ``No video could be found in this tweet`` for a photo-only post.  That is
right for a video downloader, but not for Orca: its regular image path already
uses yt-dlp and needs a real format to download.

This is deliberately a small subclass rather than a second HTTP client.  In
particular, ``_extract_status`` remains the upstream implementation, so photo
and video posts use the exact same CookieJar, X login/guest-token negotiation,
browser UA, GraphQL fallback and configured impersonation.  The only change is
turning the photo records it already fetched into image formats.
"""

from yt_dlp.extractor.twitter import TwitterIE as _TwitterIE
from yt_dlp.utils import (
    ExtractorError,
    int_or_none,
    str_or_none,
    traverse_obj,
    unified_timestamp,
    update_url_query,
)


class TwitterIE(_TwitterIE):
    """Upstream TwitterIE with static images represented as downloadable media."""

    # A plugin class with the same name overrides the bundled extractor while
    # retaining its URL matcher and all transport/authentication behaviour.
    _VALID_URL = _TwitterIE._VALID_URL

    def _real_extract(self, url):
        twid, selected_index = self._match_valid_url(url).group('id', 'index')
        status = self._extract_status(twid)
        media = traverse_obj(status, ('extended_entities', 'media', ..., {dict})) or []

        # Let upstream continue to own video, GIF, card and quoted-video posts.
        # Its mature format handling is more complete than a plugin should try to
        # duplicate. This branch is only the missing photo-only case.
        if any(entry.get('type') != 'photo' for entry in media):
            return super()._real_extract(url)

        photos = [entry for entry in media if entry.get('type') == 'photo']
        if not photos:
            return super()._real_extract(url)

        description = traverse_obj(status, (('full_text', 'text'), {str}), get_all=False) or ''
        title_text = description.replace('\n', ' ').strip()
        user = status.get('user') or {}
        uploader = user.get('name')
        uploader_id = user.get('screen_name')
        title = f'{uploader} - {title_text}' if uploader else title_text
        title = title or f'X photo {twid}'
        common = {
            'display_id': twid,
            'title': title,
            'description': description,
            'uploader': uploader,
            'uploader_id': uploader_id,
            'uploader_url': f'https://x.com/{uploader_id}' if uploader_id else None,
            'timestamp': unified_timestamp(status.get('created_at')),
            'channel_id': str_or_none(status.get('user_id_str')) or str_or_none(user.get('id_str')),
            'webpage_url': url,
            'age_limit': 18 if status.get('possibly_sensitive') else 0,
            'tags': traverse_obj(status, ('entities', 'hashtags', ..., 'text')),
        }

        def photo_entry(index, photo):
            media_url = photo.get('media_url_https') or photo.get('media_url')
            if not media_url:
                raise ExtractorError(f'Photo #{index} has no download URL', expected=True)
            original = update_url_query(media_url, {'name': 'orig'})
            info = photo.get('original_info') or photo.get('sizes', {}).get('large') or {}
            # Twitter normally places .jpg in media_url; `format` is present on
            # newer CDN URLs without an extension.
            ext = original.split('?', 1)[0].rsplit('.', 1)[-1].lower()
            if ext not in ('avif', 'gif', 'jpeg', 'jpg', 'png', 'webp'):
                ext = 'jpg'
            return {
                **common,
                'id': str_or_none(photo.get('id_str')) or f'{twid}-{index}',
                'title': f'{title} #{index}' if len(photos) > 1 else title,
                'thumbnail': media_url,
                'width': int_or_none(info.get('w') or info.get('width')),
                'height': int_or_none(info.get('h') or info.get('height')),
                'ext': ext,
                'formats': [{
                    'format_id': 'original',
                    'url': original,
                    'ext': ext,
                    'width': int_or_none(info.get('w') or info.get('width')),
                    'height': int_or_none(info.get('h') or info.get('height')),
                    # The CDN does not need X cookies, but does expect a normal
                    # page referer. yt-dlp still supplies its own browser UA.
                    'http_headers': {'Referer': url},
                }],
            }

        if selected_index:
            index = int(selected_index)
            if index < 1 or index > len(photos):
                raise ExtractorError(f'Photo #{selected_index} is unavailable', expected=True)
            return photo_entry(index, photos[index - 1])

        entries = [photo_entry(index, photo) for index, photo in enumerate(photos, 1)]
        if len(entries) == 1:
            return entries[0]
        return self.playlist_result(entries, twid, title, description)
