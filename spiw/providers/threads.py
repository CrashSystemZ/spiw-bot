from __future__ import annotations

import asyncio
import json
import re
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from spiw.config import Settings
from spiw.errors import MediaUnavailableError
from spiw.models.enums import MediaKind, Platform
from spiw.models.media import ResolvedAsset, ResolvedMediaItem

_SCRIPT_PATTERN = re.compile(r"<script[^>]*>(.*?)</script>", re.IGNORECASE | re.DOTALL)
_VIDEO_TYPE_PRIORITY = {101: 0, 102: 1, 103: 2}
_THREADS_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-CH-UA": '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}


class ThreadsPostProvider:
    platform = Platform.THREADS

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def resolve(self, url: str, media_id: str) -> ResolvedAsset:
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(self._resolve_sync, url, media_id),
                timeout=self._settings.provider_timeout_seconds + 5.0,
            )
        except TimeoutError as exc:
            raise MediaUnavailableError("The provider is taking too long to respond") from exc
        except MediaUnavailableError:
            raise
        except Exception as exc:
            raise MediaUnavailableError("Failed to load Threads post") from exc

    def _resolve_sync(self, url: str, media_id: str) -> ResolvedAsset:
        html = self._fetch_page_html(url)
        post = self._extract_post_from_dump(html, media_id)
        return self._build_asset_from_post(url, post)

    def _fetch_page_html(self, url: str) -> str:
        try:
            request = urllib.request.Request(url, headers=_THREADS_HEADERS)
            with urllib.request.urlopen(request, timeout=self._settings.http_timeout_seconds) as response:
                html = response.read().decode("utf-8", "ignore")
        except TimeoutError as exc:
            raise MediaUnavailableError("The provider is taking too long to respond") from exc
        except Exception as exc:
            raise MediaUnavailableError("Failed to load the Threads page") from exc

        if not html.strip():
            raise MediaUnavailableError("Threads returned an empty page")
        return html

    def _extract_post_from_dump(self, rendered_html: str, shortcode: str) -> dict:
        if not shortcode:
            raise MediaUnavailableError("Failed to determine the Threads post code")

        candidates: list[dict] = []
        for script in _SCRIPT_PATTERN.findall(rendered_html):
            if "RelayPrefetchedStreamCache" not in script or shortcode not in script:
                continue
            try:
                payload = json.loads(script)
            except json.JSONDecodeError:
                continue
            self._collect_post_candidates(payload, shortcode, candidates)

        if not candidates:
            raise MediaUnavailableError("Failed to extract the Threads post")
        return max(candidates, key=self._post_score)

    def _collect_post_candidates(self, node: object, shortcode: str, results: list[dict]) -> None:
        if isinstance(node, dict):
            if self._looks_like_post(node, shortcode):
                results.append(node)
            for value in node.values():
                self._collect_post_candidates(value, shortcode, results)
        elif isinstance(node, list):
            for value in node:
                self._collect_post_candidates(value, shortcode, results)

    @staticmethod
    def _looks_like_post(node: dict, shortcode: str) -> bool:
        if node.get("code") != shortcode:
            return False
        if not isinstance(node.get("text_post_app_info"), dict):
            return False
        has_media = (
            isinstance(node.get("image_versions2"), dict)
            or isinstance(node.get("video_versions"), list)
            or isinstance(node.get("carousel_media"), list)
        )
        if has_media:
            return True
        caption = node.get("caption")
        if isinstance(caption, dict) and caption.get("text"):
            return True
        fragments = ((node.get("text_post_app_info") or {}).get("text_fragments") or {}).get("fragments")
        if isinstance(fragments, list) and fragments:
            return True
        return False

    @staticmethod
    def _post_score(node: dict) -> int:
        score = 0
        if node.get("like_count") is not None:
            score += 10
        if isinstance(node.get("caption"), dict) and node["caption"].get("text"):
            score += 6
        if isinstance(node.get("text_post_app_info"), dict):
            score += 6
        if node.get("carousel_media"):
            score += 8
        if node.get("video_versions"):
            score += 4
        if node.get("image_versions2"):
            score += 2
        return score

    def _build_asset_from_post(self, url: str, post: dict) -> ResolvedAsset:
        items = self._resolve_items(post)
        description = self._extract_caption(post)
        title = description[:96] if description is not None else None

        if not items and not description:
            raise MediaUnavailableError("The Threads post does not contain supported media")

        replies = self._as_int((post.get("text_post_app_info") or {}).get("direct_reply_count"))

        return ResolvedAsset(
            platform=self.platform,
            items=items,
            force_direct_download=True,
            title=title,
            description=description,
            thumbnail_url=self._pick_thumbnail_url(post, items),
            source_url=url,
            like_count=self._as_int(post.get("like_count")),
            comment_count=replies,
        )

    def _resolve_items(self, post: dict) -> list[ResolvedMediaItem]:
        carousel = post.get("carousel_media") or []
        default_spoiler = self._is_spoiler_media(post)
        if isinstance(carousel, list) and carousel:
            items = [
                item for position, media in enumerate(carousel, start=1)
                if (item := self._resolve_media_item(media, position, default_spoiler)) is not None
            ]
            if items:
                return items

        single = self._resolve_media_item(post, 1, default_spoiler)
        return [single] if single is not None else []

    def _resolve_media_item(self, media: dict, position: int, default_spoiler: bool) -> ResolvedMediaItem | None:
        spoiler = self._is_spoiler_media(media, default_spoiler)

        video = self._pick_video_candidate(media)
        if video is not None:
            return ResolvedMediaItem(
                kind=MediaKind.ANIMATION if media.get("giphy_media_info") else MediaKind.VIDEO,
                position=position,
                width=self._as_int(media.get("original_width")),
                height=self._as_int(media.get("original_height")),
                ext=self._guess_ext(video), source_url=video, spoiler=spoiler,
            )

        image = self._pick_image_candidate(media)
        if image is None:
            return None
        return ResolvedMediaItem(
            kind=MediaKind.PHOTO, position=position,
            width=self._as_int(image.get("width")) or self._as_int(media.get("original_width")),
            height=self._as_int(image.get("height")) or self._as_int(media.get("original_height")),
            ext=self._guess_ext(image["url"]), source_url=image["url"], spoiler=spoiler,
        )

    @staticmethod
    def _pick_video_candidate(media: dict) -> str | None:
        candidates = []
        for variant in media.get("video_versions") or []:
            url = variant.get("url")
            if not isinstance(url, str) or not url.startswith("http"):
                continue
            variant_type = _VIDEO_TYPE_PRIORITY.get(
                int(variant.get("type", 99)) if variant.get("type") is not None else 99, 99
            )
            candidates.append((variant_type, url))
        if not candidates:
            return None
        candidates.sort(key=lambda c: c[0])
        return candidates[0][1]

    @staticmethod
    def _pick_image_candidate(media: dict) -> dict | None:
        candidates = []
        for candidate in (media.get("image_versions2") or {}).get("candidates") or []:
            url = candidate.get("url")
            if not isinstance(url, str) or not url.startswith("http"):
                continue
            width = int(candidate.get("width") or 0)
            height = int(candidate.get("height") or 0)
            candidates.append((-(width * height), -width, url, candidate))
        if not candidates:
            return None
        candidates.sort(key=lambda c: c[:3])
        return candidates[0][3]

    def _pick_thumbnail_url(self, post: dict, items: list[ResolvedMediaItem]) -> str | None:
        image = self._pick_image_candidate(post)
        if image is not None:
            return image["url"]
        first_child = next(iter(post.get("carousel_media") or []), None)
        if isinstance(first_child, dict):
            child_image = self._pick_image_candidate(first_child)
            if child_image is not None:
                return child_image["url"]
        return items[0].source_url if items else None

    @staticmethod
    def _extract_caption(post: dict) -> str | None:
        caption = post.get("caption")
        if isinstance(caption, dict):
            text = caption.get("text")
            if isinstance(text, str) and text.strip():
                return text.strip()

        fragments = (
            ((post.get("text_post_app_info") or {}).get("text_fragments") or {}).get("fragments") or []
        )
        parts: list[str] = []
        for fragment in fragments:
            if not isinstance(fragment, dict):
                continue
            plaintext = fragment.get("plaintext")
            if isinstance(plaintext, str) and plaintext:
                parts.append(plaintext)
                continue
            mention = (fragment.get("mention_fragment") or {}).get("username")
            if isinstance(mention, str) and mention:
                parts.append("@" + mention)
                continue
            link = (fragment.get("link_fragment") or {}).get("url")
            if isinstance(link, str) and link:
                parts.append(link)
        text = "".join(parts).strip()
        return text or None

    @staticmethod
    def _is_spoiler_media(media: dict, default: bool = False) -> bool:
        for candidate in (
            (media.get("text_post_app_info") or {}).get("is_spoiler_media"),
            media.get("is_spoiler_media"),
            (media.get("media_overlay_info") or {}).get("is_spoiler_media"),
        ):
            if isinstance(candidate, bool):
                return candidate
            if isinstance(candidate, int):
                return candidate != 0
        return default

    @staticmethod
    def _guess_ext(source_url: str) -> str:
        suffix = Path(urlparse(source_url).path).suffix.removeprefix(".").lower()
        return suffix if suffix and "/" not in suffix else "jpg"

    @staticmethod
    def _as_int(value: object) -> int | None:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
