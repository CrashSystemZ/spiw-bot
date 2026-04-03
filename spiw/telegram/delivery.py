from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from aiogram import Bot
from aiogram.types import (
    FSInputFile,
    InputMediaPhoto,
    InputMediaVideo,
    Message,
)

from spiw.errors import DeliveryError, RateLimitError
from spiw.models.enums import MediaKind
from spiw.models.media import (
    CachedMedia,
    CachedMediaItem,
    PreparedAsset,
    PreparedMediaItem,
)

logger = logging.getLogger(__name__)


class DeliveryService:

    def __init__(self, bot: Bot, service_chat_id: int) -> None:
        self._bot = bot
        self._chat_id = service_chat_id
        self._upload_lock = asyncio.Lock()

    async def upload_and_cache(self, asset: PreparedAsset) -> CachedMedia:
        items = sorted(asset.items, key=lambda i: i.position)

                                   
        has_animation = any(i.kind == MediaKind.ANIMATION for i in items)

        if len(items) == 1:
            cached_items = [await self._upload_single(items[0])]
        elif has_animation or len(items) > 10:
                                                                                   
            cached_items = []
            for item in items:
                cached_items.append(await self._upload_single(item))
        else:
            cached_items = await self._upload_media_group(items)

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
        )

    async def _upload_single(self, item: PreparedMediaItem) -> CachedMediaItem:
        async with self._upload_lock:
            try:
                input_file = FSInputFile(item.path)

                if item.kind == MediaKind.VIDEO:
                    msg = await self._bot.send_video(
                        chat_id=self._chat_id,
                        video=input_file,
                        width=item.width,
                        height=item.height,
                        duration=int(item.duration) if item.duration else None,
                        has_spoiler=item.spoiler,
                        disable_notification=True,
                    )
                elif item.kind == MediaKind.PHOTO:
                    msg = await self._bot.send_photo(
                        chat_id=self._chat_id,
                        photo=input_file,
                        has_spoiler=item.spoiler,
                        disable_notification=True,
                    )
                elif item.kind == MediaKind.ANIMATION:
                    msg = await self._bot.send_animation(
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

                return self._extract_cached_item(msg, item)

            except RateLimitError:
                raise
            except DeliveryError:
                raise
            except Exception as exc:
                logger.warning("Upload failed: %s", exc)
                raise DeliveryError(f"Upload failed: {exc}") from exc

    async def _upload_media_group(self, items: list[PreparedMediaItem]) -> list[CachedMediaItem]:
        async with self._upload_lock:
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

            try:
                messages = await self._bot.send_media_group(
                    chat_id=self._chat_id,
                    media=media_list,
                    disable_notification=True,
                )
            except Exception as exc:
                logger.warning("Media group upload failed: %s", exc)
                raise DeliveryError(f"Media group upload failed: {exc}") from exc

            cached = []
            for msg, item in zip(messages, items):
                cached.append(self._extract_cached_item(msg, item))
            return cached

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
