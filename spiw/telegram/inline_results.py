from __future__ import annotations

import hashlib
import re

from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InlineQueryResultArticle,
    InlineQueryResultCachedMpeg4Gif,
    InlineQueryResultCachedPhoto,
    InlineQueryResultCachedVideo,
    InputTextMessageContent,
)

from spiw.models.enums import MediaKind
from spiw.models.media import CachedMedia, CachedMediaItem
from spiw.utils import messages

_MD2_ESCAPE = re.compile(r"([_*\[\]()~`>#+\-=|{}.!\\])")


def _escape_md2(text: str) -> str:
    return _MD2_ESCAPE.sub(r"\\\1", text)


def _short_hash(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()[:12]


                                                                               

def format_caption(media: CachedMedia) -> str | None:
    if not media.description or media.platform not in ("x", "threads"):
        return None

    desc = media.description.strip()
    if len(desc) > 900:
        desc = desc[:900] + "..."
    caption = _escape_md2(desc)
    if len(caption) > 1024:
        caption = caption[:1020] + "\\.\\.\\."
    return caption


                                                                               

def build_post_keyboard(
    source_url: str | None = None,
    like_count: int | None = None,
    carousel_token: str | None = None,
    current_index: int = 0,
    total_items: int = 0,
    has_audio: bool = False,
) -> InlineKeyboardMarkup | None:
    rows: list[list[InlineKeyboardButton]] = []

    main_row: list[InlineKeyboardButton] = []

                  
    if like_count is not None:
        main_row.append(InlineKeyboardButton(
            text=f"\u2764\uFE0F {_format_count(like_count)}",
            callback_data="like",
        ))

                                  
    if source_url:
        main_row.append(InlineKeyboardButton(text="\U0001F4CE", url=source_url))

                                                      
    if source_url:
        main_row.append(InlineKeyboardButton(
            text="\U0001F4E4",
            switch_inline_query=source_url,
        ))

    if main_row:
        rows.append(main_row)


    if carousel_token and total_items > 1:
        prev_index = (current_index - 1) % total_items
        next_index = (current_index + 1) % total_items
        nav_row = [
            InlineKeyboardButton(text="\u2B05\uFE0F", callback_data=f"car:{carousel_token}:{prev_index}"),
            InlineKeyboardButton(text=f"{current_index + 1}/{total_items}", callback_data="noop:index"),
            InlineKeyboardButton(text="\u27A1\uFE0F", callback_data=f"car:{carousel_token}:{next_index}"),
        ]
        rows.insert(0, nav_row)

        if has_audio:
            audio_row = [InlineKeyboardButton(
                text="\U0001F3B5",
                callback_data=f"aud:{carousel_token}:{current_index}",
            )]
            rows.insert(1, audio_row)

    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


def build_audio_mode_keyboard(
    source_url: str | None = None,
    like_count: int | None = None,
    carousel_token: str | None = None,
    photo_index: int = 0,
) -> InlineKeyboardMarkup | None:
    rows: list[list[InlineKeyboardButton]] = []

    photo_row = [InlineKeyboardButton(
        text="\U0001F5BC\uFE0F",
        callback_data=f"pho:{carousel_token}:{photo_index}",
    )]
    rows.append(photo_row)

    main_row: list[InlineKeyboardButton] = []
    if like_count is not None:
        main_row.append(InlineKeyboardButton(
            text=f"\u2764\uFE0F {_format_count(like_count)}",
            callback_data="like",
        ))
    if source_url:
        main_row.append(InlineKeyboardButton(text="\U0001F4CE", url=source_url))
    if source_url:
        main_row.append(InlineKeyboardButton(
            text="\U0001F4E4",
            switch_inline_query=source_url,
        ))
    if main_row:
        rows.append(main_row)

    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


def _format_count(count: int) -> str:
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}M"
    if count >= 1_000:
        return f"{count / 1_000:.1f}K"
    return str(count)


                                                                               

def make_text_only_result(media: CachedMedia) -> list:
    caption = format_caption(media)
    text = caption or _escape_md2(media.description or media.title or "Text post")
    keyboard = build_post_keyboard(
        source_url=media.source_url,
        like_count=media.like_count,
    )
    title = media.title or "Text post"
    description = media.description or ""
    if len(description) > 100:
        description = description[:100] + "..."

    return [InlineQueryResultArticle(
        id=f"text:{_short_hash(media.cache_key)}",
        title=f"\U0001F4DD {title[:64]}",
        description=description,
        thumbnail_url=media.thumbnail_url,
        input_message_content=InputTextMessageContent(
            message_text=text,
            parse_mode="MarkdownV2",
        ),
        reply_markup=keyboard,
    )]


def make_cached_result(media: CachedMedia) -> list:
    if media.is_text_only():
        return make_text_only_result(media)
    if media.is_carousel():
        return [_make_single_cached_result(media.items[0], media, result_id_suffix="0")]
    return [_make_single_cached_result(media.items[0], media)]


def _make_single_cached_result(
    item: CachedMediaItem, media: CachedMedia, result_id_suffix: str = "",
) -> object:
    result_id = _short_hash(f"{media.cache_key}:{item.file_id}") + result_id_suffix
    caption = format_caption(media)
    keyboard = build_post_keyboard(
        source_url=media.source_url,
        like_count=media.like_count,
    )

    if item.kind == MediaKind.VIDEO:
        return InlineQueryResultCachedVideo(
            id=result_id, video_file_id=item.file_id,
            title=media.title or "Video",
            caption=caption, parse_mode="MarkdownV2" if caption else None,
            reply_markup=keyboard,
        )
    elif item.kind == MediaKind.ANIMATION:
        return InlineQueryResultCachedMpeg4Gif(
            id=result_id, mpeg4_file_id=item.file_id,
            title=media.title or "GIF",
            caption=caption, parse_mode="MarkdownV2" if caption else None,
            reply_markup=keyboard,
        )
    else:
        return InlineQueryResultCachedPhoto(
            id=result_id, photo_file_id=item.file_id,
            title=media.title or "Photo",
            caption=caption, parse_mode="MarkdownV2" if caption else None,
            reply_markup=keyboard,
        )


                                                                               

def make_loading_result(cache_key: str) -> InlineQueryResultArticle:
    return InlineQueryResultArticle(
        id=f"loading:{_short_hash(cache_key)}",
        title=f"\u23F3 {messages.LOADING}",
        description="Click to send, media will appear when ready",
        input_message_content=InputTextMessageContent(
            message_text=f"\u23F3 {messages.LOADING}",
        ),
    )


def make_error_result(error_message: str, cache_key: str = "") -> InlineQueryResultArticle:
    return InlineQueryResultArticle(
        id=f"error:{_short_hash(cache_key or error_message)}",
        title=f"\u274C {error_message}",
        input_message_content=InputTextMessageContent(
            message_text=f"\u274C {error_message}",
        ),
    )


def make_carousel_cached_result(media: CachedMedia, carousel_token: str) -> list:
    if not media.items:
        return [make_error_result("Empty carousel")]

    first_item = media.items[0]
    caption = format_caption(media)
    keyboard = build_post_keyboard(
        source_url=media.source_url,
        like_count=media.like_count,
        carousel_token=carousel_token,
        current_index=0,
        total_items=len(media.items),
        has_audio=bool(media.audio_file_id),
    )
    result_id = _short_hash(f"carousel:{media.cache_key}:{carousel_token}")

    if first_item.kind == MediaKind.VIDEO:
        return [InlineQueryResultCachedVideo(
            id=result_id, video_file_id=first_item.file_id,
            title=media.title or f"1/{len(media.items)}",
            caption=caption, parse_mode="MarkdownV2" if caption else None,
            reply_markup=keyboard,
        )]
    elif first_item.kind == MediaKind.ANIMATION:
        return [InlineQueryResultCachedMpeg4Gif(
            id=result_id, mpeg4_file_id=first_item.file_id,
            title=media.title or f"1/{len(media.items)}",
            caption=caption, parse_mode="MarkdownV2" if caption else None,
            reply_markup=keyboard,
        )]
    else:
        return [InlineQueryResultCachedPhoto(
            id=result_id, photo_file_id=first_item.file_id,
            title=media.title or f"1/{len(media.items)}",
            caption=caption, parse_mode="MarkdownV2" if caption else None,
            reply_markup=keyboard,
        )]
