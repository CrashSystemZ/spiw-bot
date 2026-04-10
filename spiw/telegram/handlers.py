from __future__ import annotations

import asyncio
import logging

from aiogram import Bot, Router
from aiogram.types import (
    CallbackQuery,
    ChosenInlineResult,
    InlineQuery,
    InlineQueryResultArticle,
    InlineQueryResultPhoto,
    InputMediaAnimation,
    InputMediaAudio,
    InputMediaPhoto,
    InputMediaVideo,
    InputTextMessageContent,
)

from spiw.config import Settings
from spiw.errors import BotError, ValidationError
from spiw.links.validator import LinkValidator
from spiw.models.enums import MediaKind
from spiw.models.inline import CarouselState
from spiw.models.media import CachedMedia, CachedMediaItem, ResolvedAsset
from spiw.storage.media_cache import MediaCacheRepository
from spiw.storage.memory import InMemoryState
from spiw.telegram.inline_results import (
    build_audio_mode_keyboard,
    build_post_keyboard,
    format_caption,
    make_cached_result,
    make_carousel_cached_result,
    make_error_result,
    make_loading_result,
    make_text_only_result,
)
from spiw.telegram.orchestrator import MediaOrchestrator
from spiw.utils import messages
from spiw.utils.hashing import build_inline_query_aliases, make_carousel_token
from spiw.telegram.inline_results import _escape_md2, _short_hash

logger = logging.getLogger(__name__)

router = Router()


class HandlerDeps:
    def __init__(
        self, bot: Bot, link_validator: LinkValidator, orchestrator: MediaOrchestrator,
        media_cache: MediaCacheRepository, state: InMemoryState, settings: Settings,
    ) -> None:
        self.bot = bot
        self.link_validator = link_validator
        self.orchestrator = orchestrator
        self.media_cache = media_cache
        self.state = state
        self.settings = settings


_deps: HandlerDeps | None = None


def register_handlers(dp, deps: HandlerDeps) -> None:
    global _deps
    _deps = deps
    dp.include_router(router)


def _d() -> HandlerDeps:
    assert _deps is not None
    return _deps


                                                                               

@router.inline_query()
async def handle_inline_query(query: InlineQuery) -> None:
    deps = _d()
    raw_query = (query.query or "").strip()
    if not raw_query:
        return

    try:
        validated = await deps.link_validator.validate(raw_query)
    except ValidationError:
        return

                      
    cached = await deps.media_cache.get(validated.cache_key)
    if not cached:
        for alias in build_inline_query_aliases(raw_query, validated.original_url, validated.normalized_url):
            cached = await deps.media_cache.get_by_query_alias(alias)
            if cached:
                break

    if cached:
                   
        if cached.is_carousel():
            token = make_carousel_token(validated.cache_key)
            _save_carousel_state(deps, token, cached)
            results = make_carousel_cached_result(cached, token)
        else:
            results = make_cached_result(cached)
        await query.answer(results=results, cache_time=deps.settings.inline_cache_seconds, is_personal=False)
        return

                                                                         
    resolved: ResolvedAsset | None = None
    try:
        resolved = await asyncio.wait_for(
            deps.orchestrator.get_resolved_metadata(validated),
            timeout=deps.settings.inline_resolve_timeout,
        )
    except (TimeoutError, Exception):
        pass

    source_url = validated.normalized_url
    keyboard = build_post_keyboard(source_url=source_url,
                                   like_count=resolved.like_count if resolved else None)

    if resolved and resolved.is_text_only():
        dummy = CachedMedia(
            cache_key=validated.cache_key, platform=resolved.platform,
            title=resolved.title, description=resolved.description,
            thumbnail_url=resolved.thumbnail_url, source_url=resolved.source_url,
            like_count=resolved.like_count, comment_count=resolved.comment_count,
        )
        results = make_text_only_result(dummy)
        await query.answer(results=results, cache_time=1, is_personal=True)
        if validated.cache_key not in deps.state.warmup_debounce:
            deps.state.warmup_debounce[validated.cache_key] = True
            asyncio.create_task(_warmup_media(deps, validated, raw_query))
        return

    is_simple_photo = (
        resolved
        and len(resolved.items) == 1
        and resolved.items[0].kind == MediaKind.PHOTO
        and not resolved.renders_as_video()
        and not resolved.items[0].spoiler
    )

    if is_simple_photo:
                                                                             
        item = resolved.items[0]
        photo_url = item.source_url or ""
        result_id = f"photo:{_short_hash(validated.cache_key)}"
        caption = format_caption_from_resolved(resolved)
        result = InlineQueryResultPhoto(
            id=result_id,
            photo_url=photo_url,
            thumbnail_url=resolved.thumbnail_url or photo_url,
            title=f"\U0001F4E4 {validated.platform.value.capitalize()} media",
            description="Click to send",
            caption=caption,
            parse_mode="MarkdownV2" if caption else None,
            reply_markup=keyboard,
        )
        if item.width:
            result.photo_width = item.width
        if item.height:
            result.photo_height = item.height
        results = [result]
    else:
                                                                              
        platform_label = validated.platform.value.capitalize()
        result_id = f"loading:{_short_hash(validated.cache_key)}"
        thumb = resolved.thumbnail_url if resolved else None
        results = [InlineQueryResultArticle(
            id=result_id,
            title=f"\U0001F4E4 {platform_label} media",
            description="Click to send",
            thumbnail_url=thumb,
            input_message_content=InputTextMessageContent(message_text=f"\u23F3 {messages.LOADING}"),
            reply_markup=keyboard,
        )]

    await query.answer(results=results, cache_time=1, is_personal=True)

                      
    if validated.cache_key not in deps.state.warmup_debounce:
        deps.state.warmup_debounce[validated.cache_key] = True
        asyncio.create_task(_warmup_media(deps, validated, raw_query))


def format_caption_from_resolved(resolved: ResolvedAsset) -> str | None:
    if not resolved.description or resolved.platform not in ("x", "threads"):
        return None
    import re
    desc = resolved.description.strip()
    if len(desc) > 900:
        desc = desc[:900] + "..."
    return re.sub(r"([_*\[\]()~`>#+\-=|{}.!\\])", r"\\\1", desc)


async def _warmup_media(deps: HandlerDeps, validated, raw_query: str) -> None:
    try:
        await deps.orchestrator.process(validated)
        aliases = build_inline_query_aliases(raw_query, validated.original_url, validated.normalized_url)
        await deps.media_cache.put_aliases(aliases, validated.cache_key)
        logger.info("Warmup complete: %s", validated.cache_key[:16])
    except BotError as e:
        logger.warning("Warmup failed: %s — %s", validated.cache_key[:16], e.message)
    except Exception:
        logger.exception("Warmup failed: %s", validated.cache_key[:16])


                                                                              

@router.chosen_inline_result()
async def handle_chosen_inline_result(chosen: ChosenInlineResult) -> None:
    deps = _d()
    inline_message_id = chosen.inline_message_id
    result_id = chosen.result_id or ""
    raw_query = (chosen.query or "").strip()

    logger.info("Chosen: result_id=%s, msg_id=%s, query=%.60s", result_id, inline_message_id, raw_query)

    if not inline_message_id or not raw_query:
        return

                                                    
    if not (result_id.startswith("loading") or result_id.startswith("failed")):
        return

    try:
        validated = await deps.link_validator.validate(raw_query)
    except ValidationError:
        return

    asyncio.create_task(_complete_inline(deps, validated, inline_message_id, raw_query))


async def _complete_inline(
    deps: HandlerDeps, validated, inline_message_id: str, raw_query: str,
) -> None:
    try:
                                               
        cached = await _wait_for_cache(deps, validated, timeout=60.0)

        if not cached:
            logger.info("Complete: cache miss after wait, processing: %s", validated.cache_key[:16])
            cached = await deps.orchestrator.process(validated)
            aliases = build_inline_query_aliases(raw_query, validated.original_url, validated.normalized_url)
            await deps.media_cache.put_aliases(aliases, validated.cache_key)

        if cached.is_text_only():
            caption = format_caption(cached)
            text = caption or _escape_md2(cached.description or cached.title or "Text post")
            keyboard = build_post_keyboard(source_url=cached.source_url, like_count=cached.like_count)
            await deps.bot.edit_message_text(
                text=text, inline_message_id=inline_message_id,
                parse_mode="MarkdownV2", reply_markup=keyboard,
            )
        elif cached.is_carousel():
            token = make_carousel_token(validated.cache_key)
            _save_carousel_state(deps, token, cached)
            await _edit_with_carousel(deps, inline_message_id, cached, token, 0)
        else:
            item = cached.items[0]
            media = _make_input_media(item, cached)
            keyboard = build_post_keyboard(source_url=cached.source_url, like_count=cached.like_count)
            await deps.bot.edit_message_media(
                media=media, inline_message_id=inline_message_id, reply_markup=keyboard,
            )

        logger.info("Complete: done %s", validated.cache_key[:16])

    except BotError as e:
        logger.warning("Complete failed: %s — %s", validated.cache_key[:16], e.message)
        try:
            await deps.bot.edit_message_text(text=f"\u274C {e.message}", inline_message_id=inline_message_id)
        except Exception:
            pass
    except Exception:
        logger.exception("Complete failed: %s", validated.cache_key[:16])
        try:
            await deps.bot.edit_message_text(text=messages.TRY_AGAIN, inline_message_id=inline_message_id)
        except Exception:
            pass


async def _wait_for_cache(deps: HandlerDeps, validated, timeout: float = 60.0) -> CachedMedia | None:
    elapsed = 0.0
    while elapsed < timeout:
        cached = await deps.media_cache.get(validated.cache_key)
        if cached:
            return cached
        await asyncio.sleep(0.25)
        elapsed += 0.25
    return None


                                                                               

@router.callback_query()
async def handle_callback_query(callback: CallbackQuery) -> None:
    deps = _d()
    data = callback.data or ""

    if data == "like":
        await callback.answer("❤️")
    elif data.startswith("noop:"):
        await callback.answer()
    elif data.startswith("car:"):
        await _handle_carousel(deps, callback, data)
    elif data.startswith("aud:"):
        await _handle_audio_toggle(deps, callback, data)
    elif data.startswith("pho:"):
        await _handle_photo_toggle(deps, callback, data)
    elif data.startswith("retry:"):
        await _handle_retry(deps, callback, data)
    else:
        await callback.answer()


async def _handle_carousel(deps: HandlerDeps, callback: CallbackQuery, data: str) -> None:
    parts = data.split(":")
    if len(parts) != 3:
        await callback.answer(messages.CAROUSEL_EXPIRED)
        return

    token = parts[1]
    try:
        index = int(parts[2])
    except ValueError:
        await callback.answer(messages.CAROUSEL_EXPIRED)
        return

    carousel = deps.state.carousel_sessions.get(token)
    if carousel is None:
        await callback.answer(messages.CAROUSEL_EXPIRED)
        return

    if index < 0 or index >= len(carousel.items):
        await callback.answer()
        return

    item_data = carousel.items[index]
    item = CachedMediaItem(
        kind=MediaKind(item_data["kind"]), file_id=item_data["file_id"],
        width=item_data.get("width"), height=item_data.get("height"),
        duration=item_data.get("duration"), spoiler=item_data.get("spoiler", False),
    )
    dummy = CachedMedia(
        cache_key=carousel.cache_key, platform=carousel.platform,
        title=carousel.title, description=carousel.description,
        source_url=carousel.source_url, like_count=carousel.like_count,
        comment_count=carousel.comment_count,
    )
    media = _make_input_media(item, dummy)
    keyboard = build_post_keyboard(
        source_url=carousel.source_url, like_count=carousel.like_count,
        carousel_token=token, current_index=index, total_items=len(carousel.items),
        has_audio=bool(carousel.audio_file_id),
    )

    try:
        if callback.inline_message_id:
            await deps.bot.edit_message_media(
                media=media, inline_message_id=callback.inline_message_id, reply_markup=keyboard,
            )
        await callback.answer()
    except Exception as exc:
        logger.warning("Carousel edit failed: %s", exc)
        await callback.answer(messages.TRY_AGAIN)


async def _handle_audio_toggle(deps: HandlerDeps, callback: CallbackQuery, data: str) -> None:
    parts = data.split(":")
    if len(parts) != 3:
        await callback.answer(messages.CAROUSEL_EXPIRED)
        return

    token = parts[1]
    try:
        photo_index = int(parts[2])
    except ValueError:
        await callback.answer(messages.CAROUSEL_EXPIRED)
        return

    carousel = deps.state.carousel_sessions.get(token)
    if carousel is None:
        await callback.answer(messages.CAROUSEL_EXPIRED)
        return

    if not carousel.audio_file_id:
        await callback.answer()
        return

    dummy = CachedMedia(
        cache_key=carousel.cache_key, platform=carousel.platform,
        title=carousel.title, description=carousel.description,
        source_url=carousel.source_url, like_count=carousel.like_count,
        comment_count=carousel.comment_count,
    )
    caption = format_caption(dummy)
    media = InputMediaAudio(
        media=carousel.audio_file_id,
        caption=caption,
        parse_mode="MarkdownV2" if caption else None,
        duration=int(carousel.audio_duration) if carousel.audio_duration else None,
    )
    keyboard = build_audio_mode_keyboard(
        source_url=carousel.source_url,
        like_count=carousel.like_count,
        carousel_token=token,
        photo_index=photo_index,
    )

    try:
        if callback.inline_message_id:
            await deps.bot.edit_message_media(
                media=media, inline_message_id=callback.inline_message_id,
                reply_markup=keyboard,
            )
        await callback.answer()
    except Exception as exc:
        logger.warning("Audio toggle failed: %s", exc)
        await callback.answer(messages.TRY_AGAIN)


async def _handle_photo_toggle(deps: HandlerDeps, callback: CallbackQuery, data: str) -> None:
    parts = data.split(":")
    if len(parts) != 3:
        await callback.answer(messages.CAROUSEL_EXPIRED)
        return

    token = parts[1]
    try:
        index = int(parts[2])
    except ValueError:
        await callback.answer(messages.CAROUSEL_EXPIRED)
        return

    carousel = deps.state.carousel_sessions.get(token)
    if carousel is None:
        await callback.answer(messages.CAROUSEL_EXPIRED)
        return

    if index < 0 or index >= len(carousel.items):
        index = 0

    item_data = carousel.items[index]
    item = CachedMediaItem(
        kind=MediaKind(item_data["kind"]), file_id=item_data["file_id"],
        width=item_data.get("width"), height=item_data.get("height"),
        duration=item_data.get("duration"), spoiler=item_data.get("spoiler", False),
    )
    dummy = CachedMedia(
        cache_key=carousel.cache_key, platform=carousel.platform,
        title=carousel.title, description=carousel.description,
        source_url=carousel.source_url, like_count=carousel.like_count,
        comment_count=carousel.comment_count,
    )
    media = _make_input_media(item, dummy)
    keyboard = build_post_keyboard(
        source_url=carousel.source_url, like_count=carousel.like_count,
        carousel_token=token, current_index=index, total_items=len(carousel.items),
        has_audio=bool(carousel.audio_file_id),
    )

    try:
        if callback.inline_message_id:
            await deps.bot.edit_message_media(
                media=media, inline_message_id=callback.inline_message_id,
                reply_markup=keyboard,
            )
        await callback.answer()
    except Exception as exc:
        logger.warning("Photo toggle failed: %s", exc)
        await callback.answer(messages.TRY_AGAIN)


async def _handle_retry(deps: HandlerDeps, callback: CallbackQuery, data: str) -> None:
    parts = data.split(":")
    if len(parts) != 2:
        await callback.answer(messages.RETRY_EXPIRED)
        return

    retry_data = deps.state.retry_state.get(parts[1])
    if retry_data is None:
        await callback.answer(messages.RETRY_EXPIRED)
        return

    await callback.answer(messages.RETRY_STARTED)
    raw_query = retry_data.get("raw_query", "")
    inline_message_id = callback.inline_message_id
    if not inline_message_id or not raw_query:
        return

    try:
        await deps.bot.edit_message_text(text=f"\u23F3 {messages.LOADING}", inline_message_id=inline_message_id)
    except Exception:
        pass

    try:
        validated = await deps.link_validator.validate(raw_query)
        cached = await deps.orchestrator.process(validated)
        aliases = build_inline_query_aliases(raw_query, validated.original_url, validated.normalized_url)
        await deps.media_cache.put_aliases(aliases, validated.cache_key)

        if cached.is_text_only():
            caption = format_caption(cached)
            text = caption or _escape_md2(cached.description or cached.title or "Text post")
            keyboard = build_post_keyboard(source_url=cached.source_url, like_count=cached.like_count)
            await deps.bot.edit_message_text(
                text=text, inline_message_id=inline_message_id,
                parse_mode="MarkdownV2", reply_markup=keyboard,
            )
        else:
            item = cached.items[0]
            media = _make_input_media(item, cached)
            keyboard = build_post_keyboard(source_url=cached.source_url, like_count=cached.like_count)
            await deps.bot.edit_message_media(
                media=media, inline_message_id=inline_message_id, reply_markup=keyboard,
            )
    except BotError as e:
        try:
            await deps.bot.edit_message_text(text=f"\u274C {e.message}", inline_message_id=inline_message_id)
        except Exception:
            pass
    except Exception:
        logger.exception("Retry failed")


                                                                               

def _save_carousel_state(deps: HandlerDeps, token: str, cached: CachedMedia) -> None:
    deps.state.carousel_sessions[token] = CarouselState(
        token=token, cache_key=cached.cache_key, platform=cached.platform,
        items=[
            {"kind": i.kind.value, "file_id": i.file_id, "width": i.width,
             "height": i.height, "duration": i.duration, "spoiler": i.spoiler}
            for i in cached.items
        ],
        title=cached.title, description=cached.description,
        source_url=cached.source_url, like_count=cached.like_count,
        comment_count=cached.comment_count,
        audio_file_id=cached.audio_file_id,
        audio_duration=cached.audio_duration,
    )


async def _edit_with_carousel(
    deps: HandlerDeps, inline_message_id: str, cached: CachedMedia,
    carousel_token: str, index: int,
) -> None:
    item = cached.items[index]
    media = _make_input_media(item, cached)
    keyboard = build_post_keyboard(
        source_url=cached.source_url, like_count=cached.like_count,
        carousel_token=carousel_token, current_index=index, total_items=len(cached.items),
        has_audio=bool(cached.audio_file_id),
    )
    await deps.bot.edit_message_media(
        media=media, inline_message_id=inline_message_id, reply_markup=keyboard,
    )


def _make_input_media(item: CachedMediaItem, media: CachedMedia):
    caption = format_caption(media)
    if item.kind == MediaKind.VIDEO:
        return InputMediaVideo(
            media=item.file_id, caption=caption,
            parse_mode="MarkdownV2" if caption else None,
            width=item.width, height=item.height,
            duration=int(item.duration) if item.duration else None,
            has_spoiler=item.spoiler,
        )
    elif item.kind == MediaKind.ANIMATION:
        return InputMediaAnimation(
            media=item.file_id, caption=caption,
            parse_mode="MarkdownV2" if caption else None,
            width=item.width, height=item.height,
            duration=int(item.duration) if item.duration else None,
            has_spoiler=item.spoiler,
        )
    else:
        return InputMediaPhoto(
            media=item.file_id, caption=caption,
            parse_mode="MarkdownV2" if caption else None,
            has_spoiler=item.spoiler,
        )
