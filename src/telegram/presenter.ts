import { BotKeyboard } from "@mtcute/node"

import type { InlineRequestContext, ResolvedMetadata, SessionAudioTrack, SessionEntry, SessionMediaItem } from "../core/models.js"
import {
    buildAudioModeKeyboard,
    buildPostKeyboard,
    makeErrorResult,
    makeLoadingResult,
    retryButton,
    toAudioMediaWithCaption,
    toInputMediaWithCaption,
} from "./ui.js"

export function presentLoadingInlineResult(request: InlineRequestContext) {
    return makeLoadingResult(request)
}

export function presentErrorInlineResult(id: string, message: string) {
    return makeErrorResult(id, message)
}

export function presentRetryMarkup(token: string) {
    return BotKeyboard.inline([
        [BotKeyboard.callback("🔄 Retry", retryButton.build({ token }))],
    ])
}

export function presentMediaMessage(
    session: SessionEntry,
    state: {
        token: string
        index: number
        captionVisible: boolean
        metadata?: ResolvedMetadata
    },
) {
    const metadata = state.metadata ?? session.metadata
    const item = pickItem(session.items, state.index)
    if (!item)
        return null

    return {
        media: toInputMediaWithCaption(item, metadata, state.captionVisible),
        replyMarkup: session.items.length > 1
            ? buildPostKeyboard(metadata, {
                token: state.token,
                currentIndex: state.index,
                totalItems: session.items.length,
                hasAudio: !!session.audio,
            })
            : buildPostKeyboard(metadata, { token: state.token }),
    }
}

export function presentAudioMessage(
    session: SessionEntry,
    track: SessionAudioTrack,
    state: {
        token: string
        index: number
        captionVisible: boolean
        metadata?: ResolvedMetadata
    },
) {
    const metadata = state.metadata ?? session.metadata
    return {
        media: toAudioMediaWithCaption(track, metadata, state.captionVisible),
        replyMarkup: buildAudioModeKeyboard(metadata, state.token, state.index),
    }
}

export function summarizeItem(item: SessionMediaItem | undefined | null) {
    if (!item)
        return null
    return {
        id: item.id,
        kind: item.kind,
        fileName: item.fileName,
        mimeType: item.mimeType,
        sizeBytes: item.buffer?.byteLength ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
        duration: item.duration ?? null,
        isAnimated: item.isAnimated ?? false,
    }
}

export function countReplyMarkupRows(replyMarkup: any) {
    return Array.isArray(replyMarkup?.buttons) ? replyMarkup.buttons.length : 0
}

function pickItem(items: SessionMediaItem[], index: number) {
    return items[index] ?? items[0] ?? null
}
