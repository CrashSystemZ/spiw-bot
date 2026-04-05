from __future__ import annotations

import asyncio
import json
from pathlib import Path

from spiw.errors import MediaUnavailableError


class FFmpegToolkit:
    def __init__(self, ffmpeg_binary: str = "ffmpeg", ffprobe_binary: str = "ffprobe") -> None:
        self._ffmpeg = ffmpeg_binary
        self._ffprobe = ffprobe_binary

    async def probe(self, path: Path) -> dict:
        result = await self._run(
            self._ffprobe, "-v", "error",
            "-print_format", "json",
            "-show_streams", "-show_format",
            str(path),
        )
        return json.loads(result) if result else {}

    async def remux_video(self, path: Path) -> Path:
        target = path.with_suffix(".mp4")
        if target == path:
            return path
        await self._run(
            self._ffmpeg, "-y", "-i", str(path),
            "-c", "copy", "-movflags", "+faststart",
            str(target),
        )
        return target

    async def convert_image_to_jpeg(self, path: Path) -> Path:
        target = path.with_suffix(".jpg")
        await self._run(
            self._ffmpeg, "-y", "-i", str(path),
            "-frames:v", "1", "-q:v", "2",
            str(target),
        )
        return target

    async def render_photo_with_audio(
        self, image_path: Path, audio_path: Path, *, duration_seconds: float | None = None,
    ) -> Path:
        target = image_path.with_name(f"{image_path.stem}-with-audio.mp4")
        command = [
            self._ffmpeg, "-y",
            "-loop", "1", "-i", str(image_path),
            "-i", str(audio_path),
            "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p",
            "-c:a", "aac", "-b:a", "320k",
            "-shortest", "-movflags", "+faststart",
        ]
        if duration_seconds is not None and duration_seconds > 0:
            command.extend(["-t", str(duration_seconds)])
        command.append(str(target))
        await self._run(*command)
        return target

    async def convert_animation_to_mp4(self, path: Path) -> Path:
        target = path.with_suffix(".mp4")
        if path.suffix.lower() == ".mp4":
            return path
        await self._run(
            self._ffmpeg, "-y", "-i", str(path),
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p",
            "-an", "-movflags", "+faststart",
            str(target),
        )
        return target

    async def _run(self, *command: str) -> str:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            message = stderr.decode("utf-8", errors="ignore").strip() or "unknown error"
            raise MediaUnavailableError(f"FFmpeg error: {message}")
        return stdout.decode("utf-8", errors="ignore")
