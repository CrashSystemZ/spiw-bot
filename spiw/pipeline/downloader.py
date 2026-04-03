from __future__ import annotations

import asyncio
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

from yt_dlp import YoutubeDL

from spiw.config import Settings
from spiw.errors import MediaUnavailableError
from spiw.models.enums import MediaKind
from spiw.models.media import ResolvedAsset, ResolvedMediaItem

_DIRECT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
_FORMAT_SELECTOR = (
    "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/"
    "best[height<=1080][ext=mp4]/"
    "best[height<=1080]/"
    "best[ext=mp4]/"
    "best"
)
_CHUNK_SIZE = 1024 * 1024


class YtDlpDownloader:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def download(self, asset: ResolvedAsset, workdir: Path) -> Path:
        workdir.mkdir(parents=True, exist_ok=True)
        try:
            await asyncio.wait_for(
                asyncio.to_thread(self._download_sync, asset, workdir),
                timeout=self._settings.provider_timeout_seconds,
            )
        except TimeoutError as exc:
            raise MediaUnavailableError("Media loading timed out") from exc
        except MediaUnavailableError:
            raise
        except Exception as exc:
            raise MediaUnavailableError("Failed to download original media") from exc
        return workdir

    def _download_sync(self, asset: ResolvedAsset, workdir: Path) -> None:
        if asset.force_direct_download or self._can_direct_download(asset):
            self._download_direct_media(asset, workdir)
            return

        options = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": False,
            "playlistend": self._settings.max_media_group_items,
            "outtmpl": str(workdir / "%(autonumber)02d-%(id)s.%(ext)s"),
            "restrictfilenames": True,
            "merge_output_format": "mp4",
            "format": _FORMAT_SELECTOR,
            "writethumbnail": False,
            "writeinfojson": False,
            "ignoreerrors": False,
            "noprogress": True,
        }
        with YoutubeDL(options) as downloader:
            result_code = downloader.download([asset.source_url or ""])
            if result_code != 0:
                raise MediaUnavailableError("yt-dlp ended with an error")

    def _download_direct_media(self, asset: ResolvedAsset, workdir: Path) -> None:
        downloads = self._build_direct_downloads(asset, workdir)
        if not downloads:
            return
        max_workers = min(len(downloads), max(1, self._settings.direct_download_concurrency))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(self._download_to_path, src, dst) for src, dst in downloads]
            for future in futures:
                future.result()

    def _build_direct_downloads(self, asset: ResolvedAsset, workdir: Path) -> list[tuple[str, Path]]:
        downloads = []
        for item in sorted(asset.items, key=lambda i: i.position):
            if item.source_url is None:
                raise MediaUnavailableError("Direct download item has no source URL")
            ext = item.ext or self._guess_ext(item.source_url)
            downloads.append((item.source_url, workdir / f"{item.position:02d}-direct.{ext}"))

        if asset.audio_track and asset.audio_track.source_url:
            ext = asset.audio_track.ext or self._guess_audio_ext(asset.audio_track.source_url)
            downloads.append((asset.audio_track.source_url, workdir / f"_audio_track.{ext}"))

        return downloads

    @staticmethod
    def _download_to_path(source_url: str, target: Path) -> None:
        request = urllib.request.Request(source_url, headers={"User-Agent": _DIRECT_UA})
        with urllib.request.urlopen(request, timeout=30) as response:
            with target.open("wb") as f:
                while chunk := response.read(_CHUNK_SIZE):
                    f.write(chunk)

    @staticmethod
    def _can_direct_download(asset: ResolvedAsset) -> bool:
        return bool(asset.items) and all(
            item.kind is MediaKind.PHOTO and item.source_url for item in asset.items
        )

    @staticmethod
    def _guess_ext(source_url: str) -> str:
        suffix = urlparse(source_url).path.rsplit(".", maxsplit=1)[-1].lower()
        return suffix if suffix else "jpg"

    @staticmethod
    def _guess_audio_ext(source_url: str) -> str:
        suffix = urlparse(source_url).path.rsplit(".", maxsplit=1)[-1].lower()
        if suffix and "/" not in suffix:
            return suffix
        if "mime_type=audio_mpeg" in source_url:
            return "mp3"
        if "mime_type=audio_mp4" in source_url:
            return "m4a"
        return "mp3"
