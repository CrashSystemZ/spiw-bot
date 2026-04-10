from __future__ import annotations

import asyncio
import json
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from spiw.config import Settings
from spiw.errors import MediaUnavailableError
from spiw.models.enums import MediaKind, Platform
from spiw.models.media import ResolvedAsset, ResolvedMediaItem
from spiw.providers.yt_dlp_base import YtDlpProviderBase

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
_FXTWITTER_API = "https://api.fxtwitter.com/status/"


class XPostProvider(YtDlpProviderBase):
    platform = Platform.X

    async def resolve(self, url: str, media_id: str) -> ResolvedAsset:
        try:
            return await self._resolve_via_fxtwitter(url, media_id)
        except MediaUnavailableError as fxe:
            try:
                asset = await super().resolve(url, media_id)
                return self._enrich_caption(asset, media_id)
            except MediaUnavailableError:
                raise fxe from None

    async def _resolve_via_fxtwitter(self, url: str, media_id: str) -> ResolvedAsset:
        try:
            payload = await asyncio.wait_for(
                asyncio.to_thread(self._fetch_payload, media_id),
                timeout=self._settings.provider_timeout_seconds,
            )
        except TimeoutError as exc:
            raise MediaUnavailableError("The provider is taking too long to respond") from exc
        except MediaUnavailableError:
            raise
        except Exception as exc:
            raise MediaUnavailableError("Failed to extract source metadata") from exc

        tweet = payload.get("tweet")
        if not isinstance(tweet, dict):
            raise MediaUnavailableError("Failed to extract source metadata")

        return self._build_asset_from_tweet(url, tweet)

    def _build_asset_from_tweet(self, url: str, tweet: dict) -> ResolvedAsset:
        items = self._collect_items_from_tweet(tweet)

        if not items:
            title = self._pick_tweet_title(tweet)
            description = self._pick_tweet_description(tweet)
            if not title and not description:
                raise MediaUnavailableError("The X post does not contain supported media")

        if items and len(items) > self._settings.max_media_group_items and not all(i.kind is MediaKind.PHOTO for i in items):
            raise MediaUnavailableError(
                f"The source returned more than {self._settings.max_media_group_items} items"
            )

        return ResolvedAsset(
            platform=self.platform,
            items=items,
            force_direct_download=True,
            title=self._pick_tweet_title(tweet),
            description=self._pick_tweet_description(tweet),
            thumbnail_url=self._pick_thumbnail(tweet, items),
            source_url=tweet.get("url") or url,
            like_count=self._as_int(tweet.get("likes")),
            comment_count=self._as_int(tweet.get("replies")),
        )

    def _fetch_payload(self, media_id: str) -> dict:
        if not media_id:
            raise MediaUnavailableError("X post id is missing.")
        request = urllib.request.Request(
            _FXTWITTER_API + media_id,
            headers={"User-Agent": _USER_AGENT},
        )
        with urllib.request.urlopen(request, timeout=self._settings.http_timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8", errors="ignore"))
        if payload.get("code") != 200 or not isinstance(payload.get("tweet"), dict):
            raise MediaUnavailableError("X fallback returned no data")
        return payload

    def _collect_items_from_tweet(self, tweet: dict) -> list[ResolvedMediaItem]:
        media = tweet.get("media") or {}
        all_items = media.get("all")
        if isinstance(all_items, list) and all_items:
            items = [r for i, m in enumerate(all_items, 1) if (r := self._resolve_media_item(m, i)) is not None]
            if items:
                return items

        for key in ("photos", "videos", "mosaic", "external"):
            media_items = media.get(key)
            if not isinstance(media_items, list):
                continue
            items = [r for i, m in enumerate(media_items, 1) if (r := self._resolve_media_item(m, i)) is not None]
            if items:
                return items
        return []

    def _resolve_media_item(self, item: dict, position: int) -> ResolvedMediaItem | None:
        item_type = str(item.get("type") or "").lower()
        if item_type == "photo":
            url = item.get("url")
            if not isinstance(url, str) or not url.startswith("http"):
                return None
            return ResolvedMediaItem(
                kind=MediaKind.PHOTO, position=position,
                width=self._as_int(item.get("width")),
                height=self._as_int(item.get("height")),
                ext=self._guess_ext_from_url(url), source_url=url,
            )
        if item_type in {"video", "gif"}:
            video_url = self._pick_video_url(item)
            if video_url is None:
                return None
            return ResolvedMediaItem(
                kind=MediaKind.ANIMATION if item_type == "gif" else MediaKind.VIDEO,
                position=position,
                width=self._as_int(item.get("width")),
                height=self._as_int(item.get("height")),
                duration=self._as_float(item.get("duration")),
                ext=self._guess_ext_from_url(video_url), source_url=video_url,
            )
        return None

    def _pick_video_url(self, item: dict) -> str | None:
        direct_url = item.get("url")
        variants = item.get("variants") or item.get("formats") or []
        candidates: list[tuple[tuple[int, int, int], str]] = []
        for variant in variants:
            variant_url = variant.get("url")
            if not isinstance(variant_url, str) or not variant_url.startswith("http"):
                continue
            content_type = str(variant.get("content_type") or "")
            container = str(variant.get("container") or "")
            is_mp4 = "video/mp4" in content_type or container == "mp4" or ".mp4" in urlparse(variant_url).path
            if not is_mp4:
                continue
            bitrate = self._as_int(variant.get("bitrate")) or self._as_int(variant.get("bit_rate")) or 0
            width = self._as_int(variant.get("width")) or self._as_int(item.get("width")) or 0
            candidates.append(((0 if bitrate and bitrate <= 8_000_000 else 1, -bitrate, -width), variant_url))

        if candidates:
            candidates.sort(key=lambda e: e[0])
            return candidates[0][1]
        return direct_url if isinstance(direct_url, str) and direct_url.startswith("http") else None

    @staticmethod
    def _pick_tweet_title(tweet: dict) -> str | None:
        text = tweet.get("text") or (tweet.get("raw_text") or {}).get("text")
        return str(text).strip()[:96] if text else None

    @staticmethod
    def _pick_tweet_description(tweet: dict) -> str | None:
        text = tweet.get("text") or (tweet.get("raw_text") or {}).get("text")
        if not text:
            return None
        desc = str(text).strip()
        if not desc:
            return None
        import re
        desc = re.sub(r"\s*https?://t\.co/\S+\s*$", "", desc).strip()
        return desc or None

    @staticmethod
    def _pick_thumbnail(tweet: dict, items: list[ResolvedMediaItem]) -> str | None:
        media = tweet.get("media") or {}
        for video in media.get("videos") or media.get("all") or []:
            thumbnail = video.get("thumbnail_url")
            if isinstance(thumbnail, str) and thumbnail.startswith("http"):
                return thumbnail
        return items[0].source_url if items else None

    def _enrich_caption(self, asset: ResolvedAsset, media_id: str) -> ResolvedAsset:
        if asset.description and asset.title:
            return asset
        try:
            payload = self._fetch_payload(media_id)
        except Exception:
            return asset
        tweet = payload.get("tweet") or {}
        return ResolvedAsset(
            platform=asset.platform, items=asset.items,
            audio_track=asset.audio_track,
            force_direct_download=asset.force_direct_download,
            title=self._pick_tweet_title(tweet) or asset.title,
            description=self._pick_tweet_description(tweet) or asset.description,
            thumbnail_url=self._pick_thumbnail(tweet, asset.items) or asset.thumbnail_url,
            source_url=tweet.get("url") or asset.source_url,
            like_count=self._as_int(tweet.get("likes")) or asset.like_count,
            comment_count=self._as_int(tweet.get("replies")) or asset.comment_count,
        )

    @staticmethod
    def _guess_ext_from_url(source_url: str) -> str:
        suffix = Path(urlparse(source_url).path).suffix.removeprefix(".").lower()
        return suffix if suffix and "/" not in suffix else "jpg"
