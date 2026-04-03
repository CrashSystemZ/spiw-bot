from __future__ import annotations

import re
from urllib.parse import urlparse

from spiw.errors import ValidationError
from spiw.links.normalizers import LinkNormalizer
from spiw.links.redirect import resolve_redirect
from spiw.models.validated_url import ValidatedUrl
from spiw.utils.hashing import cache_seed, make_cache_key

                                                    
_URL_PATTERN = re.compile(r"https?://\S+", re.IGNORECASE)


class LinkValidator:
    def __init__(self, normalizers: list[LinkNormalizer]) -> None:
        self._normalizers = normalizers

    async def validate(self, raw_query: str) -> ValidatedUrl:
        candidate_url = self._extract_url(raw_query)
        normalizer = self._find_normalizer(candidate_url)

                                        
        if normalizer.requires_expansion(candidate_url):
            candidate_url = await resolve_redirect(candidate_url)
            normalizer = self._find_normalizer(candidate_url)
            if normalizer.requires_expansion(candidate_url):
                raise ValidationError()

        normalized = normalizer.normalize(candidate_url)
        seed = cache_seed(normalized)
        key = make_cache_key(normalized.platform, seed)

        return ValidatedUrl(
            original_url=raw_query.strip(),
            normalized_url=normalized.url,
            platform=normalized.platform,
            media_id=normalized.media_id,
            cache_key=key,
        )

    def _extract_url(self, raw_query: str) -> str:
        text = raw_query.strip()
        if not text:
            raise ValidationError()

                              
        if text.startswith("http://") or text.startswith("https://"):
            candidate = text.split()[0]
        else:
            match = _URL_PATTERN.search(text)
            if not match:
                raise ValidationError()
            candidate = match.group(0)

                                
        candidate = candidate.rstrip(".,;!?)>")

                           
        if candidate.startswith("http://"):
            candidate = "https://" + candidate[7:]

                       
        try:
            parsed = urlparse(candidate)
            if not parsed.scheme or not parsed.hostname:
                raise ValidationError()
        except ValueError:
            raise ValidationError()

        return candidate

    def _find_normalizer(self, url: str) -> LinkNormalizer:
        try:
            host = urlparse(url).hostname
        except ValueError:
            raise ValidationError()

        if not host:
            raise ValidationError()

        host = host.lower()
        for n in self._normalizers:
            if n.supports_host(host):
                return n

        raise ValidationError()
