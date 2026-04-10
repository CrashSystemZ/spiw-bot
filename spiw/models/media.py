from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from spiw.models.enums import MediaKind, Platform


@dataclass(frozen=True, slots=True)
class ResolvedMediaItem:
    kind: MediaKind
    position: int = 0
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    ext: str | None = None
    source_url: str | None = None
    spoiler: bool = False


@dataclass(frozen=True, slots=True)
class ResolvedAudioTrack:
    source_url: str
    duration: float | None = None
    ext: str | None = None


@dataclass(slots=True)
class ResolvedAsset:
    platform: Platform
    items: list[ResolvedMediaItem]
    audio_track: ResolvedAudioTrack | None = None
    force_direct_download: bool = False
    title: str | None = None
    description: str | None = None
    thumbnail_url: str | None = None
    source_url: str | None = None
    like_count: int | None = None
    comment_count: int | None = None

    def is_carousel(self) -> bool:
        return len(self.items) > 1

    def is_photo_carousel(self) -> bool:
        return len(self.items) > 1 and all(i.kind == MediaKind.PHOTO for i in self.items)

    def renders_as_video(self) -> bool:
        return (
            len(self.items) == 1
            and self.items[0].kind == MediaKind.PHOTO
            and self.audio_track is not None
            and bool(self.audio_track.source_url)
        )

    def is_text_only(self) -> bool:
        return not self.items and bool(self.title or self.description)

    def effective_duration(self) -> float | None:
        if self.renders_as_video() and self.audio_track:
            return self.audio_track.duration
        if len(self.items) == 1:
            return self.items[0].duration
        return None


@dataclass(frozen=True, slots=True)
class PreparedMediaItem:
    kind: MediaKind
    path: Path
    position: int = 0
    size_bytes: int = 0
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    spoiler: bool = False


@dataclass(slots=True)
class PreparedAsset:
    cache_key: str
    platform: Platform
    workdir: Path
    items: list[PreparedMediaItem]
    title: str | None = None
    description: str | None = None
    thumbnail_url: str | None = None
    source_url: str | None = None
    like_count: int | None = None
    comment_count: int | None = None
    audio_path: Path | None = None
    audio_duration: float | None = None


@dataclass(frozen=True, slots=True)
class CachedMediaItem:
    kind: MediaKind
    file_id: str
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    spoiler: bool = False


@dataclass(slots=True)
class CachedMedia:
    cache_key: str
    platform: Platform
    items: list[CachedMediaItem] = field(default_factory=list)
    title: str | None = None
    description: str | None = None
    thumbnail_url: str | None = None
    source_url: str | None = None
    like_count: int | None = None
    comment_count: int | None = None
    audio_file_id: str | None = None
    audio_duration: float | None = None

    def is_carousel(self) -> bool:
        return len(self.items) > 1

    def is_text_only(self) -> bool:
        return not self.items and bool(self.title or self.description)
