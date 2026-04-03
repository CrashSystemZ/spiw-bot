from __future__ import annotations

import logging

import aiohttp

logger = logging.getLogger(__name__)

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/146.0.0.0 Safari/537.36"
)


async def resolve_redirect(url: str, timeout: float = 10.0) -> str:
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url,
                allow_redirects=True,
                max_redirects=10,
                timeout=aiohttp.ClientTimeout(total=timeout, connect=5),
                headers={"User-Agent": _USER_AGENT},
            ) as resp:
                return str(resp.url)
    except Exception:
        logger.debug("Redirect resolve failed for %s, returning original", url)
        return url
