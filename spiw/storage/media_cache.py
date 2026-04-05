from __future__ import annotations

import json

import aiosqlite

from spiw.models.enums import MediaKind, Platform
from spiw.models.media import CachedMedia, CachedMediaItem


class MediaCacheRepository:
    def __init__(self, db: aiosqlite.Connection) -> None:
        self._db = db

    async def get(self, cache_key: str) -> CachedMedia | None:
        async with self._db.execute(
            "SELECT * FROM media_cache WHERE cache_key = ?", (cache_key,)
        ) as cursor:
            row = await cursor.fetchone()
            return self._row_to_cached(row) if row else None

    async def get_by_query_alias(self, alias_hash: str) -> CachedMedia | None:
        async with self._db.execute(
            """SELECT mc.* FROM query_aliases qa
               JOIN media_cache mc ON qa.cache_key = mc.cache_key
               WHERE qa.alias_hash = ?""",
            (alias_hash,),
        ) as cursor:
            row = await cursor.fetchone()
            return self._row_to_cached(row) if row else None

    async def put(self, media: CachedMedia) -> None:
        await self._db.execute(
            """INSERT OR REPLACE INTO media_cache
               (cache_key, platform, items_json, title, description,
                thumbnail_url, source_url, like_count, comment_count,
                audio_file_id, audio_duration)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                media.cache_key,
                media.platform.value,
                json.dumps([self._item_to_dict(i) for i in media.items]),
                media.title,
                media.description,
                media.thumbnail_url,
                media.source_url,
                media.like_count,
                media.comment_count,
                media.audio_file_id,
                media.audio_duration,
            ),
        )
        await self._db.commit()

    async def put_aliases(self, aliases: list[str], cache_key: str) -> None:
        await self._db.executemany(
            "INSERT OR IGNORE INTO query_aliases (alias_hash, cache_key) VALUES (?, ?)",
            [(alias, cache_key) for alias in aliases],
        )
        await self._db.commit()

    async def exists(self, cache_key: str) -> bool:
        async with self._db.execute(
            "SELECT 1 FROM media_cache WHERE cache_key = ? LIMIT 1", (cache_key,)
        ) as cursor:
            return await cursor.fetchone() is not None

    def _row_to_cached(self, row: aiosqlite.Row) -> CachedMedia:
        items = [self._dict_to_item(d) for d in json.loads(row["items_json"])]
        return CachedMedia(
            cache_key=row["cache_key"],
            platform=Platform(row["platform"]),
            items=items,
            title=row["title"],
            description=row["description"],
            thumbnail_url=row["thumbnail_url"],
            source_url=row["source_url"],
            like_count=row["like_count"],
            comment_count=row["comment_count"],
            audio_file_id=row["audio_file_id"],
            audio_duration=row["audio_duration"],
        )

    @staticmethod
    def _item_to_dict(item: CachedMediaItem) -> dict:
        return {
            "kind": item.kind.value,
            "file_id": item.file_id,
            "width": item.width,
            "height": item.height,
            "duration": item.duration,
            "spoiler": item.spoiler,
        }

    @staticmethod
    def _dict_to_item(d: dict) -> CachedMediaItem:
        return CachedMediaItem(
            kind=MediaKind(d["kind"]),
            file_id=d["file_id"],
            width=d.get("width"),
            height=d.get("height"),
            duration=d.get("duration"),
            spoiler=d.get("spoiler", False),
        )
