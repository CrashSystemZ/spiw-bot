from __future__ import annotations

import logging
import shutil

from spiw.config import Settings
from spiw.errors import BotError, DurationLimitError
from spiw.models.enums import Platform
from spiw.models.media import CachedMedia, ResolvedAsset
from spiw.models.validated_url import ValidatedUrl
from spiw.pipeline.processor import MediaPipeline
from spiw.providers.base import MediaProvider
from spiw.storage.media_cache import MediaCacheRepository
from spiw.storage.memory import InMemoryState
from spiw.telegram.delivery import DeliveryService

logger = logging.getLogger(__name__)


class MediaOrchestrator:
    def __init__(
        self,
        cache: MediaCacheRepository,
        state: InMemoryState,
        providers: dict[Platform, MediaProvider],
        pipeline: MediaPipeline,
        delivery: DeliveryService,
        settings: Settings,
    ) -> None:
        self._cache = cache
        self._state = state
        self._providers = providers
        self._pipeline = pipeline
        self._delivery = delivery
        self._settings = settings

    async def process(self, validated: ValidatedUrl) -> CachedMedia:
                                 
        cached = await self._cache.get(validated.cache_key)
        if cached:
            return cached

                                      
        lock = self._state.get_lock(validated.cache_key)
        async with lock:
                                     
            cached = await self._cache.get(validated.cache_key)
            if cached:
                return cached

                                                           
            asset = self._state.provider_cache.get(validated.cache_key)
            if not asset:
                provider = self._get_provider(validated.platform)
                asset = await provider.resolve(validated.normalized_url, validated.media_id)
                self._state.provider_cache[validated.cache_key] = asset

            if asset.is_text_only():
                cached_media = CachedMedia(
                    cache_key=validated.cache_key,
                    platform=asset.platform,
                    items=[],
                    title=asset.title,
                    description=asset.description,
                    thumbnail_url=asset.thumbnail_url,
                    source_url=asset.source_url,
                    like_count=asset.like_count,
                    comment_count=asset.comment_count,
                )
                await self._cache.put(cached_media)
                return cached_media


            duration = asset.effective_duration()
            if duration and duration > self._settings.max_video_duration_seconds:
                raise DurationLimitError(self._settings.max_video_duration_seconds)


            async with self._state.processing_semaphore:
                workdir = self._settings.media_temp_dir / validated.cache_key.replace(":", "_")[:16]
                workdir.mkdir(parents=True, exist_ok=True)
                try:
                    prepared = await self._pipeline.prepare(asset, workdir)
                    prepared.cache_key = validated.cache_key

                    cached_media = await self._delivery.upload_and_cache(prepared)

                    await self._cache.put(cached_media)
                    return cached_media
                finally:
                    shutil.rmtree(workdir, ignore_errors=True)

    async def get_resolved_metadata(self, validated: ValidatedUrl) -> ResolvedAsset | None:
        asset = self._state.provider_cache.get(validated.cache_key)
        if asset:
            return asset
        try:
            provider = self._get_provider(validated.platform)
            asset = await provider.resolve(validated.normalized_url, validated.media_id)
            self._state.provider_cache[validated.cache_key] = asset
            return asset
        except BotError:
            return None

    def _get_provider(self, platform: Platform) -> MediaProvider:
        provider = self._providers.get(platform)
        if provider is None:
            raise BotError("UNSUPPORTED_PLATFORM", f"No provider for {platform}")
        return provider
