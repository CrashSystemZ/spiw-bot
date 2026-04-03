from __future__ import annotations

from dataclasses import dataclass

from spiw.models.enums import Platform


@dataclass(frozen=True, slots=True)
class NormalizedLink:
    url: str
    platform: Platform
    media_id: str
    use_normalized_url_for_cache: bool = False


@dataclass(frozen=True, slots=True)
class ValidatedUrl:
    original_url: str
    normalized_url: str
    platform: Platform
    media_id: str
    cache_key: str
