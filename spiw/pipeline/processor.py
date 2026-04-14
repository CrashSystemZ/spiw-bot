from __future__ import annotations

import asyncio
import mimetypes
import shutil
from pathlib import Path

from spiw.config import Settings
from spiw.errors import MediaUnavailableError
from spiw.models.enums import MediaKind
from spiw.models.media import PreparedAsset, PreparedMediaItem, ResolvedAsset, ResolvedMediaItem
from spiw.pipeline.downloader import YtDlpDownloader
from spiw.pipeline.ffmpeg import FFmpegToolkit

_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
_ANIMATION_SUFFIXES = {".gif"}
_VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}
_AUDIO_SUFFIXES = {".mp3", ".m4a", ".aac", ".wav", ".ogg"}
_IGNORED_SUFFIXES = {".part", ".ytdl", ".json", ".txt", ".description", ".vtt", ".srt"}


class MediaPipeline:
    def __init__(self, downloader: YtDlpDownloader, ffmpeg: FFmpegToolkit, settings: Settings) -> None:
        self._downloader = downloader
        self._ffmpeg = ffmpeg
        self._settings = settings

    async def prepare(self, asset: ResolvedAsset, workdir: Path) -> PreparedAsset:
        await self._downloader.download(asset, workdir)

        if asset.renders_as_video():
            prepared_items = [await self._prepare_photo_video(asset, workdir)]
        else:
            media_files = self._discover_media_files(workdir)
            if not media_files:
                raise MediaUnavailableError("No media files found after download")
            prepared_items = list(await asyncio.gather(*[
                self._prepare_file(
                    index, path,
                    asset.items[index - 1] if index <= len(asset.items) else None,
                )
                for index, path in enumerate(media_files, start=1)
            ]))

        audio_path = None
        audio_duration = None
        if asset.audio_track and not asset.renders_as_video():
            try:
                audio_path = self._discover_audio_file(workdir)
                probe = await self._safe_probe(audio_path)
                fmt = probe.get("format", {})
                audio_duration = _as_float(fmt.get("duration")) or asset.audio_track.duration
            except MediaUnavailableError:
                audio_path = None

        return PreparedAsset(
            cache_key="",
            platform=asset.platform,
            workdir=workdir,
            items=prepared_items,
            title=asset.title,
            description=asset.description,
            thumbnail_url=asset.thumbnail_url,
            source_url=asset.source_url,
            like_count=asset.like_count,
            comment_count=asset.comment_count,
            audio_path=audio_path,
            audio_duration=audio_duration,
        )

    async def cleanup(self, workdir: Path | None) -> None:
        if workdir is not None:
            await asyncio.to_thread(shutil.rmtree, workdir, True)

    def _discover_media_files(self, workdir: Path) -> list[Path]:
        files = []
        for candidate in sorted(workdir.rglob("*")):
            if not candidate.is_file():
                continue
            if candidate.suffix.lower() in _IGNORED_SUFFIXES:
                continue
            if candidate.name.startswith("_audio_track."):
                continue
            files.append(candidate)
        return files

    async def _prepare_photo_video(self, asset: ResolvedAsset, workdir: Path) -> PreparedMediaItem:
        image_path = self._discover_single_file(workdir, _IMAGE_SUFFIXES, "image")
        audio_path = self._discover_audio_file(workdir)

        normalized_image = image_path
        if image_path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            normalized_image = await self._ffmpeg.convert_image_to_jpeg(image_path)

        video_path = await self._ffmpeg.render_photo_with_audio(
            normalized_image, audio_path,
            duration_seconds=asset.audio_track.duration if asset.audio_track else None,
        )
                                                              
        return await self._prepare_file(1, video_path, resolved_item=None)

    def _discover_single_file(self, workdir: Path, suffixes: set[str], label: str) -> Path:
        matches = [
            c for c in sorted(workdir.rglob("*"))
            if c.is_file() and c.suffix.lower() in suffixes
        ]
        if not matches:
            raise MediaUnavailableError(f"Couldn't find {label} after loading")
        return matches[0]

    def _discover_audio_file(self, workdir: Path) -> Path:
        named_track = next(
            (c for c in sorted(workdir.rglob("_audio_track.*")) if c.is_file()), None
        )
        if named_track is not None:
            return named_track
        return self._discover_single_file(workdir, _AUDIO_SUFFIXES, "audio track")

    async def _prepare_file(
        self, position: int, path: Path, resolved_item: ResolvedMediaItem | None = None,
    ) -> PreparedMediaItem:
        kind_hint = resolved_item.kind if resolved_item else None
        spoiler = resolved_item.spoiler if resolved_item else False
        kind = kind_hint or self._guess_kind(path)
        normalized_path = path

        if kind is MediaKind.PHOTO and path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            normalized_path = await self._ffmpeg.convert_image_to_jpeg(path)

        if kind is MediaKind.ANIMATION:
            normalized_path = await self._ffmpeg.convert_animation_to_mp4(path)

        if kind is MediaKind.VIDEO and path.suffix.lower() not in {".mp4", ".mov"}:
            normalized_path = await self._ffmpeg.remux_video(path)

        width, height, duration = self._extract_known_metadata(resolved_item)
        needs_probe = kind is not MediaKind.PHOTO and (width is None or height is None)
        if needs_probe:
            metadata = await self._safe_probe(normalized_path)
            video_stream = next(
                (s for s in metadata.get("streams", []) if s.get("codec_type") == "video"), {}
            )
            width = width or _as_int(video_stream.get("width"))
            height = height or _as_int(video_stream.get("height"))
            duration = duration or _as_float(
                video_stream.get("duration") or metadata.get("format", {}).get("duration"),
            )

        return PreparedMediaItem(
            kind=kind,
            position=position,
            path=normalized_path,
            size_bytes=normalized_path.stat().st_size if normalized_path.exists() else 0,
            width=width,
            height=height,
            duration=duration,
            spoiler=spoiler,
        )

    @staticmethod
    def _extract_known_metadata(
        resolved_item: ResolvedMediaItem | None,
    ) -> tuple[int | None, int | None, float | None]:
        if resolved_item is None:
            return None, None, None
        return resolved_item.width, resolved_item.height, resolved_item.duration

    async def _safe_probe(self, path: Path) -> dict:
        try:
            return await self._ffmpeg.probe(path)
        except MediaUnavailableError:
            return {}

    @staticmethod
    def _guess_kind(path: Path) -> MediaKind:
        suffix = path.suffix.lower()
        if suffix in _IMAGE_SUFFIXES:
            return MediaKind.PHOTO
        if suffix in _ANIMATION_SUFFIXES:
            return MediaKind.ANIMATION
        if suffix in _VIDEO_SUFFIXES:
            return MediaKind.VIDEO
        mime, _ = mimetypes.guess_type(path.name)
        if mime and mime.startswith("image/"):
            return MediaKind.PHOTO
        if mime == "image/gif":
            return MediaKind.ANIMATION
        if mime and mime.startswith("video/"):
            return MediaKind.VIDEO
        raise MediaUnavailableError(f"Unsupported file type: {path.name}")


def _as_int(value: object) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
