from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

from aiogram import Bot
from aiogram.types import (
    FSInputFile,
    InputMediaPhoto,
    InputMediaVideo,
    Message,
)

from spiw.errors import DeliveryError
from spiw.models.enums import MediaKind
from spiw.models.media import (
    CachedMedia,
    CachedMediaItem,
    PreparedAsset,
    PreparedMediaItem,
)

logger = logging.getLogger(__name__)

_RETRY_AFTER_PATTERN = re.compile(r"retry after (\d+)", re.IGNORECASE)
_SUCCESS_COOLDOWN = 0.25
_RATE_LIMIT_PADDING = 1.0
_MAX_RETRIES = 5
_MEDIA_GROUP_LIMIT = 10
_UPLOAD_CONCURRENCY = 5


class DeliveryService:

    def __init__(self, bot: Bot, service_chat_id: int) -> None:
        self._bot = bot
        self._chat_id = service_chat_id
        self._upload_semaphore = asyncio.Semaphore(_UPLOAD_CONCURRENCY)
        self._next_allowed_at: float = 0.0

    async def upload_and_cache(self, asset: PreparedAsset) -> CachedMedia:
        items = sorted(asset.items, key=lambda i: i.position)

        has_animation = any(i.kind == MediaKind.ANIMATION for i in items)

        if len(items) == 1:
            cached_items = [await self._upload_single(items[0])]
        elif has_animation or len(items) > _MEDIA_GROUP_LIMIT:
            cached_items = list(await asyncio.gather(*[
                self._upload_single(item) for item in items
            ]))
        else:
            cached_items = await self._upload_media_group(items)

        audio_file_id = None
        audio_duration = asset.audio_duration
        if asset.audio_path and asset.audio_path.exists():
            audio_file_id = await self._upload_audio(asset.audio_path, audio_duration)

        return CachedMedia(
            cache_key=asset.cache_key,
            platform=asset.platform,
            items=cached_items,
            title=asset.title,
            description=asset.description,
            thumbnail_url=asset.thumbnail_url,
            source_url=asset.source_url,
            like_count=asset.like_count,
            comment_count=asset.comment_count,
            audio_file_id=audio_file_id,
            audio_duration=audio_duration,
        )

    async def _upload_single(self, item: PreparedMediaItem) -> CachedMediaItem:
        async def _do_upload() -> Message:
            input_file = FSInputFile(item.path)
            if item.kind == MediaKind.VIDEO:
                return await self._bot.send_video(
                    chat_id=self._chat_id,
                    video=input_file,
                    width=item.width,
                    height=item.height,
                    duration=int(item.duration) if item.duration else None,
                    has_spoiler=item.spoiler,
                    disable_notification=True,
                )
            elif item.kind == MediaKind.PHOTO:
                return await self._bot.send_photo(
                    chat_id=self._chat_id,
                    photo=input_file,
                    has_spoiler=item.spoiler,
                    disable_notification=True,
                )
            elif item.kind == MediaKind.ANIMATION:
                return await self._bot.send_animation(
                    chat_id=self._chat_id,
                    animation=input_file,
                    width=item.width,
                    height=item.height,
                    duration=int(item.duration) if item.duration else None,
                    has_spoiler=item.spoiler,
                    disable_notification=True,
                )
            else:
                raise DeliveryError(f"Unsupported media kind: {item.kind}")

        msg = await self._execute_with_retry("send_media", _do_upload)
        return self._extract_cached_item(msg, item)

    async def _upload_media_group(self, items: list[PreparedMediaItem]) -> list[CachedMediaItem]:
        media_list = []
        for item in items:
            input_file = FSInputFile(item.path)
            if item.kind == MediaKind.VIDEO:
                media_list.append(InputMediaVideo(
                    media=input_file,
                    width=item.width,
                    height=item.height,
                    duration=int(item.duration) if item.duration else None,
                    has_spoiler=item.spoiler,
                ))
            elif item.kind == MediaKind.PHOTO:
                media_list.append(InputMediaPhoto(
                    media=input_file,
                    has_spoiler=item.spoiler,
                ))
            else:
                raise DeliveryError(f"Media group doesn't support kind: {item.kind}")

        async def _do_upload() -> list[Message]:
            return await self._bot.send_media_group(
                chat_id=self._chat_id,
                media=media_list,
                disable_notification=True,
            )

        messages = await self._execute_with_retry("send_media_group", _do_upload)
        return [self._extract_cached_item(msg, item) for msg, item in zip(messages, items)]

    async def _upload_audio(self, audio_path: Path, duration: float | None = None) -> str:
        async def _do_upload() -> Message:
            return await self._bot.send_audio(
                chat_id=self._chat_id,
                audio=FSInputFile(audio_path),
                duration=int(duration) if duration else None,
                disable_notification=True,
            )

        msg = await self._execute_with_retry("send_audio", _do_upload)
        if not msg.audio or not msg.audio.file_id:
            raise DeliveryError("Could not extract audio file_id")
        return msg.audio.file_id

    async def _execute_with_retry(self, method_name: str, action):
        async with self._upload_semaphore:
            for attempt in range(_MAX_RETRIES):
                await self._wait_cooldown()
                try:
                    result = await action()
                    self._extend_cooldown(_SUCCESS_COOLDOWN)
                    return result
                except Exception as exc:
                    retry_after = self._parse_retry_after(exc)
                    if retry_after is not None and attempt < _MAX_RETRIES - 1:
                        wait_time = retry_after + _RATE_LIMIT_PADDING
                        logger.warning(
                            "Rate limited on %s, retry after %.1fs (attempt %d/%d)",
                            method_name, wait_time, attempt + 1, _MAX_RETRIES,
                        )
                        self._extend_cooldown(wait_time)
                        continue
                    logger.warning("Upload failed on %s: %s", method_name, exc)
                    raise DeliveryError(f"Upload failed: {exc}") from exc

    async def _wait_cooldown(self) -> None:
        now = asyncio.get_event_loop().time()
        delay = self._next_allowed_at - now
        if delay > 0:
            await asyncio.sleep(delay)

    def _extend_cooldown(self, seconds: float) -> None:
        now = asyncio.get_event_loop().time()
        candidate = now + seconds
        self._next_allowed_at = max(self._next_allowed_at, candidate)

    @staticmethod
    def _parse_retry_after(exc: Exception) -> float | None:
        if hasattr(exc, "retry_after"):
            return float(exc.retry_after)
        match = _RETRY_AFTER_PATTERN.search(str(exc))
        if match:
            return float(match.group(1))
        return None

    @staticmethod
    def _extract_cached_item(msg: Message, item: PreparedMediaItem) -> CachedMediaItem:
        file_id: str | None = None

        if msg.video:
            file_id = msg.video.file_id
        elif msg.photo:
            file_id = msg.photo[-1].file_id
        elif msg.animation:
            file_id = msg.animation.file_id
        elif msg.document:
            file_id = msg.document.file_id

        if not file_id:
            raise DeliveryError("Could not extract file_id from Telegram response")

        return CachedMediaItem(
            kind=item.kind,
            file_id=file_id,
            width=item.width,
            height=item.height,
            duration=item.duration,
            spoiler=item.spoiler,
        )
