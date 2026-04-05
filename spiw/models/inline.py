from __future__ import annotations

import time
from dataclasses import dataclass, field

from spiw.models.enums import JobStatus
from spiw.models.media import CachedMedia


@dataclass
class InlineSession:
    cache_key: str
    raw_query: str
    status: JobStatus = JobStatus.RESOLVING
    inline_message_id: str | None = None
    result_id: str | None = None
    result: CachedMedia | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.monotonic)


@dataclass
class CarouselState:
    token: str
    cache_key: str
    platform: str
    items: list[dict]                                                       
    current_index: int = 0
    title: str | None = None
    description: str | None = None
    source_url: str | None = None
    like_count: int | None = None
    comment_count: int | None = None
    audio_file_id: str | None = None
    audio_duration: float | None = None
