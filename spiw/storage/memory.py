from __future__ import annotations

import asyncio
import time

from cachetools import TTLCache

from spiw.models.inline import CarouselState, InlineSession


class InMemoryState:
    def __init__(self) -> None:
        self.provider_cache: TTLCache = TTLCache(maxsize=1000, ttl=3600)
        self.inline_sessions: dict[str, InlineSession] = {}
        self.carousel_sessions: TTLCache[str, CarouselState] = TTLCache(maxsize=500, ttl=259200)
        self.warmup_debounce: TTLCache[str, bool] = TTLCache(maxsize=1000, ttl=30)
        self.retry_state: TTLCache[str, dict] = TTLCache(maxsize=500, ttl=300)
        self._locks: dict[str, asyncio.Lock] = {}
        self.processing_semaphore: asyncio.Semaphore | None = None

    def get_lock(self, key: str) -> asyncio.Lock:
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]

    def cleanup_old_sessions(self, max_age_seconds: float = 3600) -> None:
        now = time.monotonic()
        expired = [
            k for k, v in self.inline_sessions.items()
            if now - v.created_at > max_age_seconds
        ]
        for k in expired:
            del self.inline_sessions[k]

    def cleanup_old_locks(self, max_size: int = 5000) -> None:
        if len(self._locks) > max_size:
            unlocked = [k for k, v in self._locks.items() if not v.locked()]
            for k in unlocked[: len(self._locks) - max_size]:
                del self._locks[k]
