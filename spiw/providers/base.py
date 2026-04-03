from __future__ import annotations

from typing import Protocol

from spiw.models.enums import Platform
from spiw.models.media import ResolvedAsset


class MediaProvider(Protocol):
    platform: Platform

    async def resolve(self, url: str, media_id: str) -> ResolvedAsset:
        ...
