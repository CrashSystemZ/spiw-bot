from __future__ import annotations

import asyncio
from pathlib import Path
from urllib.parse import urlparse

from yt_dlp import YoutubeDL

from spiw.config import Settings
from spiw.errors import MediaUnavailableError
from spiw.models.enums import MediaKind, Platform
from spiw.models.media import ResolvedAsset, ResolvedAudioTrack, ResolvedMediaItem

_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}


class YtDlpProviderBase:
    platform: Platform

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def resolve(self, url: str, media_id: str) -> ResolvedAsset:
        try:
            info = await asyncio.wait_for(
                asyncio.to_thread(self._extract_info, url),
                timeout=self._settings.provider_timeout_seconds,
            )
        except TimeoutError as exc:
            raise MediaUnavailableError("The provider is taking too long to respond") from exc
        except MediaUnavailableError:
            raise
        except Exception as exc:
            raise MediaUnavailableError("Failed to extract source metadata") from exc

        raw_items = self._collect_raw_items(info)
        items = self._collect_items(raw_items)
        if not items:
            raise MediaUnavailableError("The provider did not return supported media")

        if (
            len(items) > self._settings.max_media_group_items
            and not all(item.kind is MediaKind.PHOTO for item in items)
        ):
            raise MediaUnavailableError(
                f"The provider returned more than {self._settings.max_media_group_items} items"
            )

        audio_track = (
            self._pick_audio_track(raw_items[0], info)
            if len(items) == 1 and items[0].kind is MediaKind.PHOTO
            else None
        )
        return ResolvedAsset(
            platform=self.platform,
            items=items,
            audio_track=audio_track,
            title=self._pick_title(info),
            description=self._pick_description(info),
            thumbnail_url=info.get("thumbnail"),
            source_url=info.get("webpage_url") or url,
            like_count=self._as_int(info.get("like_count")),
            comment_count=self._as_int(info.get("comment_count")),
        )

    def _extract_info(self, url: str) -> dict:
        options = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": False,
            "playlistend": self._settings.max_media_group_items,
            "extract_flat": False,
        }
        with YoutubeDL(options) as downloader:
            return downloader.extract_info(url, download=False)

    @staticmethod
    def _collect_raw_items(info: dict) -> list[dict]:
        entries = info.get("entries")
        return [entry for entry in entries if entry] if entries else [info]

    def _collect_items(self, raw_items: list[dict]) -> list[ResolvedMediaItem]:
        items: list[ResolvedMediaItem] = []
        for index, item in enumerate(raw_items, start=1):
            kind = self._guess_kind(item)
            items.append(
                ResolvedMediaItem(
                    kind=kind,
                    position=index,
                    width=self._as_int(item.get("width")),
                    height=self._as_int(item.get("height")),
                    duration=self._as_float(item.get("duration")),
                    ext=item.get("ext"),
                    source_url=self._pick_source_url(item, kind),
                )
            )
        return items

    def _guess_kind(self, entry: dict) -> MediaKind:
        ext = str(entry.get("ext") or "").lower()
        url = str(entry.get("url") or "")
        inferred_suffix = Path(urlparse(url).path).suffix.removeprefix(".").lower()
        effective_ext = ext or inferred_suffix

        if entry.get("_type") == "image":
            return MediaKind.PHOTO
        if effective_ext in _IMAGE_EXTENSIONS:
            return MediaKind.PHOTO
        return MediaKind.VIDEO

    def _pick_source_url(self, item: dict, kind: MediaKind) -> str | None:
        if kind is MediaKind.PHOTO:
            return self._pick_photo_source_url(item)

        direct_url = item.get("url")
        if isinstance(direct_url, str) and direct_url.startswith("http"):
            return direct_url

        formats = item.get("formats") or []
        preferred = self._preferred_format(formats)
        if preferred is not None:
            return preferred

        for fmt in formats:
            fmt_url = fmt.get("url")
            if not isinstance(fmt_url, str) or not fmt_url.startswith("http"):
                continue
            ext = str(fmt.get("ext") or "").lower()
            vcodec = str(fmt.get("vcodec") or "")
            acodec = str(fmt.get("acodec") or "")
            if vcodec != "none" and ext in {"mp4", "mov", "m4v"}:
                if acodec != "none":
                    return fmt_url

        for fmt in formats:
            fmt_url = fmt.get("url")
            if isinstance(fmt_url, str) and fmt_url.startswith("http"):
                return fmt_url
        return None

    @staticmethod
    def _pick_photo_source_url(item: dict) -> str | None:
        formats = item.get("formats") or []
        for fmt in formats:
            fmt_url = fmt.get("url")
            if not isinstance(fmt_url, str) or not fmt_url.startswith("http"):
                continue
            ext = str(fmt.get("ext") or "").lower()
            if ext in _IMAGE_EXTENSIONS:
                return fmt_url

        direct_url = item.get("url")
        if isinstance(direct_url, str) and direct_url.startswith("http"):
            return direct_url
        return None

    def _pick_audio_track(self, item: dict, info: dict) -> ResolvedAudioTrack | None:
        formats = item.get("formats") or []
        candidates: list[tuple[tuple[int, int], ResolvedAudioTrack]] = []
        for fmt in formats:
            fmt_url = fmt.get("url")
            if not isinstance(fmt_url, str) or not fmt_url.startswith("http"):
                continue

            vcodec = str(fmt.get("vcodec") or "")
            acodec = str(fmt.get("acodec") or "")
            if vcodec != "none" or acodec == "none":
                continue

            ext = str(fmt.get("ext") or "").lower() or None
            abr = self._as_int(fmt.get("abr")) or 0
            tbr = self._as_int(fmt.get("tbr")) or 0
            duration = (
                self._as_float(fmt.get("duration"))
                or self._as_float(item.get("duration"))
                or self._as_float(info.get("duration"))
            )
            candidates.append((
                (0 if ext in {"m4a", "mp3", "aac"} else 1, -(abr or tbr)),
                ResolvedAudioTrack(source_url=fmt_url, duration=duration, ext=ext),
            ))

        if not candidates:
            return None
        candidates.sort(key=lambda c: c[0])
        return candidates[0][1]

    def _preferred_format(self, formats: list[dict]) -> str | None:
        candidates: list[tuple[tuple[int, int, int], str]] = []
        for fmt in formats:
            fmt_url = fmt.get("url")
            if not isinstance(fmt_url, str) or not fmt_url.startswith("http"):
                continue

            vcodec = str(fmt.get("vcodec") or "")
            if vcodec == "none":
                continue

            ext = str(fmt.get("ext") or "").lower()
            if ext not in {"mp4", "mov", "m4v"}:
                continue

            height = self._as_int(fmt.get("height")) or 0
            fps = self._as_int(fmt.get("fps")) or 0
            acodec = str(fmt.get("acodec") or "")
            has_audio = acodec != "none"
            if not has_audio:
                continue

            score = (
                0 if height and height <= 1080 else 1,
                -height,
                -(fps or 30),
            )
            candidates.append((score, fmt_url))

        if not candidates:
            return None
        candidates.sort(key=lambda c: c[0])
        return candidates[0][1]

    @staticmethod
    def _pick_title(info: dict) -> str | None:
        title = info.get("title") or info.get("fulltitle") or info.get("description")
        return str(title).strip() if title else None

    @staticmethod
    def _pick_description(info: dict) -> str | None:
        description = info.get("description")
        return str(description).strip() if description else None

    @staticmethod
    def _as_int(value: object) -> int | None:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _as_float(value: object) -> float | None:
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
