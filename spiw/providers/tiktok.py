from __future__ import annotations

import asyncio
import json
import re
import urllib.request
from urllib.parse import urlencode, urlparse

from spiw.config import Settings
from spiw.errors import MediaUnavailableError
from spiw.models.enums import MediaKind, Platform
from spiw.models.media import ResolvedAsset, ResolvedAudioTrack, ResolvedMediaItem
from spiw.providers.yt_dlp_base import YtDlpProviderBase

_MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
_HYDRATION_PATTERN = re.compile(
    r'<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', re.S,
)
_API_DATA_PATTERN = re.compile(
    r'<script[^>]+id="api-data"[^>]*>(.*?)</script>', re.S,
)


class TikTokProvider(YtDlpProviderBase):
    platform = Platform.TIKTOK

    async def resolve(self, url: str, media_id: str) -> ResolvedAsset:
        if "/photo/" in url:
            try:
                return await self._resolve_photo_post(url)
            except MediaUnavailableError:
                return await self._resolve_via_tikwm(url)
        try:
            return self._coerce_story_asset(await super().resolve(url, media_id))
        except MediaUnavailableError:
            return self._coerce_story_asset(await self._resolve_via_tikwm(url))

                                      

    async def _resolve_photo_post(self, url: str) -> ResolvedAsset:
        try:
            item_struct = await asyncio.wait_for(
                asyncio.to_thread(self._extract_photo_post, url),
                timeout=self._settings.provider_timeout_seconds,
            )
        except TimeoutError as exc:
            raise MediaUnavailableError("The provider is taking too long to respond") from exc
        except MediaUnavailableError:
            raise
        except Exception as exc:
            raise MediaUnavailableError("Failed to extract source metadata") from exc

        image_post = item_struct.get("imagePost") or {}
        images = image_post.get("images") or []
        if not images:
            raise MediaUnavailableError("TikTok photo post does not contain images")

        items: list[ResolvedMediaItem] = []
        for index, image in enumerate(images, start=1):
            image_url = next(iter(image.get("imageURL", {}).get("urlList", [])), None)
            if image_url is None:
                continue
            items.append(ResolvedMediaItem(
                kind=MediaKind.PHOTO,
                position=index,
                width=self._as_int(image.get("imageWidth")),
                height=self._as_int(image.get("imageHeight")),
                ext=self._guess_ext(image_url),
                source_url=image_url,
            ))

        if not items:
            raise MediaUnavailableError("TikTok photo post does not contain supported images")

                                                   
        force_direct_download = False
        try:
            tikwm_payload = await asyncio.wait_for(
                asyncio.to_thread(self._fetch_tikwm_payload, url),
                timeout=self._settings.provider_timeout_seconds,
            )
        except Exception:
            tikwm_payload = None

        if isinstance(tikwm_payload, dict):
            items, force_direct_download = self._merge_photo_items(items, tikwm_payload.get("data"))

        stats = item_struct.get("stats") or {}
        return ResolvedAsset(
            platform=self.platform,
            items=items,
            audio_track=self._extract_audio_track(item_struct),
            force_direct_download=force_direct_download,
            title=self._pick_tiktok_title(item_struct),
            description=str(item_struct.get("desc") or "").strip() or None,
            thumbnail_url=self._pick_cover_url(image_post),
            source_url=url,
            like_count=self._as_int(stats.get("diggCount")),
            comment_count=self._as_int(stats.get("commentCount")),
        )

    def _extract_photo_post(self, url: str) -> dict:
        request = urllib.request.Request(url, headers={"User-Agent": _MOBILE_UA})
        with urllib.request.urlopen(request, timeout=self._settings.http_timeout_seconds) as response:
            html = response.read().decode("utf-8", errors="ignore")

        item_struct = self._extract_photo_item_struct(html)
        if not item_struct:
            raise MediaUnavailableError("TikTok item payload not found")
        if "imagePost" not in item_struct:
            raise MediaUnavailableError("TikTok image post payload not found")
        return item_struct

    @staticmethod
    def _extract_photo_item_struct(html: str) -> dict:
        api_match = _API_DATA_PATTERN.search(html)
        if api_match is not None:
            payload = json.loads(api_match.group(1))
            item_struct = (
                payload.get("videoDetail", {}).get("itemInfo", {}).get("itemStruct", {})
            )
            if item_struct:
                return item_struct

        match = _HYDRATION_PATTERN.search(html)
        if match is None:
            raise MediaUnavailableError("TikTok hydration payload not found")
        payload = json.loads(match.group(1))
        return (
            payload.get("__DEFAULT_SCOPE__", {})
            .get("webapp.reflow.video.detail", {})
            .get("itemInfo", {})
            .get("itemStruct", {})
        )

                          

    async def _resolve_via_tikwm(self, url: str) -> ResolvedAsset:
        try:
            payload = await asyncio.wait_for(
                asyncio.to_thread(self._fetch_tikwm_payload, url),
                timeout=self._settings.provider_timeout_seconds,
            )
        except TimeoutError as exc:
            raise MediaUnavailableError("The provider is taking too long to respond") from exc
        except MediaUnavailableError:
            raise
        except Exception as exc:
            raise MediaUnavailableError("Failed to extract source metadata") from exc

        data = payload.get("data") or {}
        images = data.get("images") or []
        if images:
            items = [
                ResolvedMediaItem(
                    kind=MediaKind.PHOTO, position=index,
                    ext=self._guess_ext(image_url), source_url=image_url,
                )
                for index, image_url in enumerate(images, start=1)
                if isinstance(image_url, str) and image_url.startswith("http")
            ]
            if not items:
                raise MediaUnavailableError("TikTok fallback didn't return supported images")
            items, _ = self._merge_photo_items(items, data)
            audio_url = data.get("music")
            audio_track = (
                ResolvedAudioTrack(
                    source_url=audio_url,
                    duration=self._as_float(data.get("duration")),
                    ext="mp3",
                )
                if isinstance(audio_url, str) and audio_url.startswith("http")
                else None
            )
        else:
            video_url = next(
                (c for c in (data.get("hdplay"), data.get("play"), data.get("wmplay"))
                 if isinstance(c, str) and c.startswith("http")),
                None,
            )
            if video_url is None:
                raise MediaUnavailableError("TikTok fallback didn't return the video")
            items = [ResolvedMediaItem(
                kind=MediaKind.VIDEO, position=1,
                duration=self._as_float(data.get("duration")),
                ext="mp4", source_url=video_url,
            )]
            audio_track = None

        return ResolvedAsset(
            platform=self.platform,
            items=items, audio_track=audio_track,
            force_direct_download=True,
            title=str(data.get("title") or "").strip() or None,
            description=str(data.get("content_desc") or data.get("title") or "").strip() or None,
            thumbnail_url=data.get("cover") or data.get("origin_cover"),
            source_url=url,
            like_count=self._as_int(data.get("digg_count")),
            comment_count=self._as_int(data.get("comment_count")),
        )

    def _fetch_tikwm_payload(self, url: str) -> dict:
        api_url = f"{self._settings.tiktok_fallback_api_url}?{urlencode({'url': url})}"
        request = urllib.request.Request(api_url, headers={"User-Agent": _MOBILE_UA})
        with urllib.request.urlopen(request, timeout=self._settings.http_timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8", errors="ignore"))
        if payload.get("code") != 0 or not isinstance(payload.get("data"), dict):
            raise MediaUnavailableError("TikTok fallback returned no data")
        return payload

                          

    def _coerce_story_asset(self, asset: ResolvedAsset) -> ResolvedAsset:
        if len(asset.items) != 1 or asset.audio_track is not None or not asset.thumbnail_url:
            return asset
        item = asset.items[0]
        if item.kind is not MediaKind.VIDEO or not item.source_url or not self._looks_like_audio_story(item):
            return asset
        return ResolvedAsset(
            platform=asset.platform,
            items=[ResolvedMediaItem(
                kind=MediaKind.PHOTO, position=1,
                width=item.width, height=item.height,
                ext=self._guess_ext(asset.thumbnail_url),
                source_url=asset.thumbnail_url,
            )],
            audio_track=ResolvedAudioTrack(
                source_url=item.source_url,
                duration=item.duration,
                ext=self._guess_audio_ext(item.source_url, item.ext),
            ),
            force_direct_download=True,
            title=asset.title, description=asset.description,
            thumbnail_url=asset.thumbnail_url, source_url=asset.source_url,
            like_count=asset.like_count, comment_count=asset.comment_count,
        )

                              

    def _merge_photo_items(
        self, items: list[ResolvedMediaItem], data: dict | None,
    ) -> tuple[list[ResolvedMediaItem], bool]:
        if not isinstance(data, dict):
            return items, False

        live_images = self._normalize_live_images(data.get("live_images"))
        if not live_images:
            return items, False

        merged: list[ResolvedMediaItem] = []
        has_live_slot = False
        for item in items:
            live_image = live_images.get(item.position)
            live_url = self._pick_live_image_url(live_image)
            if live_url is None:
                merged.append(item)
                continue
            merged.append(ResolvedMediaItem(
                kind=MediaKind.ANIMATION, position=item.position,
                width=item.width, height=item.height,
                ext="mp4", source_url=live_url,
            ))
            has_live_slot = True

        return merged, has_live_slot

    @staticmethod
    def _normalize_live_images(live_images: object) -> dict[int, object]:
        if isinstance(live_images, list):
            return {i: v for i, v in enumerate(live_images, start=1)}
        if isinstance(live_images, dict):
            out: dict[int, object] = {}
            for key, value in live_images.items():
                try:
                    out[int(key)] = value
                except (TypeError, ValueError):
                    continue
            return out
        return {}

    @staticmethod
    def _pick_live_image_url(live_image: object) -> str | None:
        if isinstance(live_image, str) and live_image.startswith("http"):
            return live_image
        if not isinstance(live_image, dict):
            return None
        for key in ("url", "src", "play", "play_url", "download_url", "video_url"):
            candidate = live_image.get(key)
            if isinstance(candidate, str) and candidate.startswith("http"):
                return candidate
        for nested_key in ("images", "imageURL", "urlList"):
            nested = live_image.get(nested_key)
            if isinstance(nested, list):
                for c in nested:
                    if isinstance(c, str) and c.startswith("http"):
                        return c
            if isinstance(nested, dict):
                url_list = nested.get("urlList")
                if isinstance(url_list, list):
                    for c in url_list:
                        if isinstance(c, str) and c.startswith("http"):
                            return c
        return None

                   

    @staticmethod
    def _pick_cover_url(image_post: dict) -> str | None:
        return next(iter(image_post.get("cover", {}).get("imageURL", {}).get("urlList", [])), None)

    @classmethod
    def _extract_audio_track(cls, item_struct: dict) -> ResolvedAudioTrack | None:
        music = item_struct.get("music") or {}
        play_url = music.get("playUrl")
        if not isinstance(play_url, str) or not play_url.startswith("http"):
            return None
        return ResolvedAudioTrack(
            source_url=play_url,
            duration=cls._as_float(music.get("duration")),
            ext="mp3",
        )

    @staticmethod
    def _pick_tiktok_title(item_struct: dict) -> str | None:
        title = str(item_struct.get("desc") or item_struct.get("imagePost", {}).get("title") or "").strip()
        return title[:96] if title else None

    @staticmethod
    def _guess_ext(source_url: str) -> str:
        suffix = urlparse(source_url).path.rsplit(".", maxsplit=1)[-1].lower()
        return suffix if suffix else "jpeg"

    @staticmethod
    def _looks_like_audio_story(item: ResolvedMediaItem) -> bool:
        ext = (item.ext or "").lower()
        source = item.source_url or ""
        return ext in {"mp3", "m4a", "aac"} or "mime_type=audio_" in source

    @staticmethod
    def _guess_audio_ext(source_url: str, fallback_ext: str | None) -> str:
        if fallback_ext:
            lowered = fallback_ext.lower()
            if lowered in {"mp3", "m4a", "aac", "wav", "ogg"}:
                return lowered
        suffix = urlparse(source_url).path.rsplit(".", maxsplit=1)[-1].lower()
        if suffix and "/" not in suffix:
            return suffix
        if "mime_type=audio_mpeg" in source_url:
            return "mp3"
        if "mime_type=audio_mp4" in source_url:
            return "m4a"
        return "mp3"
