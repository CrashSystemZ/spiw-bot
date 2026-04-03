from __future__ import annotations

from typing import Protocol
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from spiw.errors import ValidationError
from spiw.models.enums import Platform
from spiw.models.validated_url import NormalizedLink

                                           
_TRACKING_KEYS = {"feature", "si"}


class LinkNormalizer(Protocol):
    def supports_host(self, host: str) -> bool: ...
    def requires_expansion(self, url: str) -> bool: ...
    def normalize(self, url: str) -> NormalizedLink: ...


def _normalize_host(host: str | None) -> str:
    return (host or "").lower()


def _path_segments(path: str) -> list[str]:
    return [s for s in path.split("/") if s]


def _append_filtered_query(base_url: str, query_string: str) -> str:
    if not query_string:
        return base_url
    params = parse_qs(query_string, keep_blank_values=True)
    filtered = {k: v for k, v in params.items() if k not in _TRACKING_KEYS}
    if not filtered:
        return base_url
    return f"{base_url}?{urlencode(filtered, doseq=True)}"


                                                                               

class TikTokNormalizer:
    _SUPPORTED = {"www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"}
    _REDIRECT = {"vm.tiktok.com", "vt.tiktok.com"}

    def supports_host(self, host: str) -> bool:
        return _normalize_host(host) in self._SUPPORTED

    def requires_expansion(self, url: str) -> bool:
        parsed = urlparse(url)
        host = _normalize_host(parsed.hostname)

        if host in self._REDIRECT:
            return True

                                                 
        if host in ("www.tiktok.com", "m.tiktok.com"):
            segments = _path_segments(parsed.path)
            if segments and segments[0] == "t":
                return True

        return False

    def normalize(self, url: str) -> NormalizedLink:
        parsed = urlparse(url)
        segments = _path_segments(parsed.path)
        query = parse_qs(parsed.query, keep_blank_values=True)

                                                              
        for i in range(len(segments) - 1):
            current = segments[i]
            if current not in ("video", "photo"):
                continue

            media_id = segments[i + 1]
            base_path = "/".join(segments[: i + 2])
            base_url = f"https://www.tiktok.com/{base_path}"

                                    
            if self._is_story_link(query):
                story_url = _append_filtered_query(base_url, parsed.query)
                return NormalizedLink(story_url, Platform.TIKTOK, media_id, use_normalized_url_for_cache=True)

            return NormalizedLink(base_url, Platform.TIKTOK, media_id)

        raise ValidationError("Only TikTok video and photo links are supported \U0001F4A9")

    @staticmethod
    def _is_story_link(query: dict) -> bool:
        return (
            query.get("story_type", [None])[0] == "1"
            or "share_item_id" in query
            or "story_uid" in query
        )


                                                                               

class InstagramNormalizer:
    _SUPPORTED = {"instagram.com", "www.instagram.com"}

    def supports_host(self, host: str) -> bool:
        return _normalize_host(host) in self._SUPPORTED

    def requires_expansion(self, url: str) -> bool:
        return False

    def normalize(self, url: str) -> NormalizedLink:
        parsed = urlparse(url)
        segments = _path_segments(parsed.path)

        if len(segments) >= 2 and segments[0] in ("reel", "reels"):
            media_id = segments[1]
            return NormalizedLink(
                f"https://www.instagram.com/reel/{media_id}",
                Platform.INSTAGRAM, media_id,
            )

        if len(segments) >= 2 and segments[0] == "p":
            media_id = segments[1]
            return NormalizedLink(
                f"https://www.instagram.com/p/{media_id}",
                Platform.INSTAGRAM, media_id,
            )

        raise ValidationError("Only Instagram posts and Reels are supported \U0001F921")


                                                                               

class XNormalizer:
    _SUPPORTED = {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}

    def supports_host(self, host: str) -> bool:
        return _normalize_host(host) in self._SUPPORTED

    def requires_expansion(self, url: str) -> bool:
        return False

    def normalize(self, url: str) -> NormalizedLink:
        parsed = urlparse(url)
        segments = _path_segments(parsed.path)

                                            
        for i in range(1, len(segments)):
            if segments[i] != "status":
                continue
            if i + 1 >= len(segments):
                break

            handle = segments[i - 1]
            media_id = segments[i + 1]
            if not handle or not media_id:
                break

            return NormalizedLink(
                f"https://x.com/{handle}/status/{media_id}",
                Platform.X, media_id,
            )

        raise ValidationError("Only X links of the form /status/<id> are supported \U0001F62A")


                                                                               

class ThreadsNormalizer:
    _SUPPORTED = {"threads.com", "www.threads.com", "threads.net", "www.threads.net"}

    def supports_host(self, host: str) -> bool:
        return _normalize_host(host) in self._SUPPORTED

    def requires_expansion(self, url: str) -> bool:
        return False

    def normalize(self, url: str) -> NormalizedLink:
        parsed = urlparse(url)
        segments = _path_segments(parsed.path)

                                     
        if (
            len(segments) >= 3
            and segments[0].startswith("@")
            and segments[1] == "post"
        ):
            handle = segments[0]
            media_id = segments[2]
            if handle and media_id:
                return NormalizedLink(
                    f"https://www.threads.com/{handle}/post/{media_id}",
                    Platform.THREADS, media_id,
                )

        raise ValidationError("Only Threads links of the form /@user/post/<code> are supported \U0001F612")


                                                                               

def create_normalizers() -> list[LinkNormalizer]:
    return [
        TikTokNormalizer(),
        InstagramNormalizer(),
        XNormalizer(),
        ThreadsNormalizer(),
    ]
