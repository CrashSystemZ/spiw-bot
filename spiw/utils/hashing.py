from __future__ import annotations

import hashlib
import time
from urllib.parse import urlparse

from spiw.models.enums import Platform
from spiw.models.validated_url import NormalizedLink


def sha256(text: str) -> str:
    return hashlib.sha256((text or "").encode()).hexdigest()


def md5(text: str) -> str:
    return hashlib.md5((text or "").encode()).hexdigest()


def make_cache_key(platform: Platform, source: str) -> str:
    return f"{platform.value}:{sha256(source)}"


def cache_seed(normalized: NormalizedLink) -> str:
    if normalized.use_normalized_url_for_cache:
        return normalized.url
    return normalized.media_id or normalized.url


def make_carousel_token(seed: str) -> str:
    return md5(f"{seed}:{time.time()}")[:16]


def canonicalize_inline_query(raw_query: str) -> str:
    candidate = (raw_query or "").strip()
    if not candidate:
        return ""

    try:
        parsed = urlparse(candidate)
    except ValueError:
        return candidate

    if not parsed.scheme or not parsed.hostname:
        return candidate

    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")

    authority = parsed.hostname.lower()
    if parsed.port:
        authority = f"{authority}:{parsed.port}"

    result = f"{parsed.scheme.lower()}://{authority}{path}"
    if parsed.query:
        result += f"?{parsed.query}"

    return result


def build_inline_query_aliases(*queries: str) -> list[str]:
    seen: set[str] = set()
    for query in queries:
        stripped = (query or "").strip()
        if not stripped:
            continue

        variants = [stripped]
        try:
            parsed = urlparse(stripped)
            if parsed.scheme and parsed.hostname:
                path = parsed.path or ""
                if path.endswith("/") and path != "/":
                    norm_path = path.rstrip("/")
                    authority = parsed.hostname.lower()
                    if parsed.port:
                        authority = f"{authority}:{parsed.port}"
                    variant = f"{parsed.scheme.lower()}://{authority}{norm_path}"
                    if parsed.query:
                        variant += f"?{parsed.query}"
                    variants.append(variant)
        except ValueError:
            pass

        for v in variants:
            canonical = canonicalize_inline_query(v)
            if canonical:
                seen.add(canonical)

    return list(seen)
