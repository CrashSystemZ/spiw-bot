import {CallbackDataBuilder} from "@mtcute/dispatcher"
import {BotInline, BotKeyboard} from "@mtcute/node"

import type {InlineRequestContext, ResolvedMetadata, SessionAudioTrack, SessionMediaItem} from "../core/models.js"
import {messages} from "../core/messages.js"

export const carouselButton = new CallbackDataBuilder("car", "token", "index")
export const audioButton = new CallbackDataBuilder("aud", "token", "index")
export const photoButton = new CallbackDataBuilder("pho", "token", "index")
export const captionButton = new CallbackDataBuilder("cap", "token")
export const retryButton = new CallbackDataBuilder("ret", "token")

export function formatCaption(metadata: ResolvedMetadata) {
    const title = cleanCaptionPart(metadata.title)
    const description = cleanCaptionPart(metadata.description)

    if (!title && !description)
        return undefined

    const parts: string[] = []
    if (title && description) {
        const normalizedTitle = title.toLowerCase()
        const normalizedDescription = description.toLowerCase()
        if (normalizedTitle === normalizedDescription || normalizedDescription.includes(normalizedTitle)) {
            parts.push(description)
        } else if (normalizedTitle.includes(normalizedDescription)) {
            parts.push(title)
        } else {
            parts.push(title, description)
        }
    } else if (description) {
        parts.push(description)
    } else if (title) {
        parts.push(title)
    }

    const caption = parts.join("\n\n").trim()
    if (!caption)
        return undefined
    return caption.length > 1000 ? `${caption.slice(0, 997)}...` : caption
}

export function buildPostKeyboard(
    metadata: ResolvedMetadata,
    options: {
        token?: string
        currentIndex?: number
        totalItems?: number
        hasAudio?: boolean
        captionVisible?: boolean
    } = {},
) {
    const rows: any[][] = []

    if (options.token && options.totalItems && options.totalItems > 1) {
        const currentIndex = options.currentIndex ?? 0
        const prevIndex = (currentIndex - 1 + options.totalItems) % options.totalItems
        const nextIndex = (currentIndex + 1) % options.totalItems
        rows.push([
            BotKeyboard.callback("⬅️", carouselButton.build({token: options.token, index: String(prevIndex)})),
            BotKeyboard.callback(`${currentIndex + 1}/${options.totalItems}`, "noop:index"),
            BotKeyboard.callback("➡️", carouselButton.build({token: options.token, index: String(nextIndex)})),
        ])

        if (options.hasAudio) {
            rows.push([
                BotKeyboard.callback("🎵", audioButton.build({token: options.token, index: String(currentIndex)})),
            ])
        }
    }

    const mainRow: any[] = []

    if (options.token && shouldShowCaptionButton(metadata))
        mainRow.push(BotKeyboard.callback("💬", captionButton.build({token: options.token})))

    if (metadata.sourceUrl)
        mainRow.push(BotKeyboard.url("📎", metadata.sourceUrl))
    if (metadata.sourceUrl)
        mainRow.push(BotKeyboard.switchInline("📤", {query: metadata.sourceUrl}))

    if (mainRow.length)
        rows.push(mainRow)
    return BotKeyboard.inline(rows)
}

export function buildAudioModeKeyboard(
    metadata: ResolvedMetadata,
    token: string,
    photoIndex: number,
) {
    const main = buildPostKeyboard(metadata, {token}) as any
    return BotKeyboard.inline([
        [BotKeyboard.callback("🖼️", photoButton.build({token, index: String(photoIndex)}))],
        ...(main.buttons?.slice(-1) ?? []),
    ])
}

export function buildLoadingKeyboard(metadata: ResolvedMetadata) {
    const targetUrl = metadata.normalizedUrl

    return BotKeyboard.inline([
        [
            BotKeyboard.url("📎", targetUrl),
            BotKeyboard.switchInline("📤", {query: targetUrl}),
        ],
    ])
}

export function makeLoadingResult(context: InlineRequestContext) {
    const title = `📤 ${messages.clickToSend}`
    return BotInline.article(context.requestId, {
        title,
        message: {
            type: "text",
            text: `⏳ ${messages.loading}`,
            replyMarkup: buildLoadingKeyboard(context.metadata),
        },
    })
}

export function makeErrorResult(id: string, message: string) {
    return BotInline.article(id, {
        title: `❌ ${message}`,
        description: message,
    })
}

export function toInputMediaWithCaption(item: SessionMediaItem, metadata: ResolvedMetadata, includeCaption: boolean) {
    const caption = includeCaption ? (formatCaption(metadata) ?? "") : ""
    switch (item.kind) {
        case "photo":
            return {
                type: "photo",
                file: item.buffer,
                fileName: item.fileName,
                caption,
            } as any
        case "animation":
            return {
                type: "video",
                file: item.buffer,
                fileName: item.fileName,
                mimeType: item.mimeType ?? undefined,
                caption,
                isAnimated: true,
            } as any
        case "audio":
            return {
                type: "audio",
                file: item.buffer,
                fileName: item.fileName,
                mimeType: item.mimeType ?? undefined,
                caption,
            } as any
        case "document":
            return {
                type: "document",
                file: item.buffer,
                fileName: item.fileName,
                mimeType: item.mimeType ?? undefined,
                caption,
            } as any
        case "video":
        default:
            return {
                type: "video",
                file: item.buffer,
                fileName: item.fileName,
                mimeType: item.mimeType ?? undefined,
                caption,
                isAnimated: item.isAnimated ?? false,
            } as any
    }
}

export function toAudioMediaWithCaption(track: SessionAudioTrack, metadata: ResolvedMetadata, includeCaption: boolean) {
    return {
        type: "audio",
        file: track.buffer,
        fileName: track.fileName,
        mimeType: track.mimeType ?? undefined,
        caption: includeCaption ? (formatCaption(metadata) ?? "") : "",
    } as any
}

export function hasCaption(metadata: ResolvedMetadata) {
    return Boolean(formatCaption(metadata))
}

function shouldShowCaptionButton(metadata: ResolvedMetadata) {
    if (hasCaption(metadata))
        return true
    if (isPrettyMetadataLoaded(metadata))
        return false
    return metadata.platform === "tiktok"
        || metadata.platform === "instagram"
        || metadata.platform === "x"
        || metadata.platform === "threads"
}

function isPrettyMetadataLoaded(metadata: ResolvedMetadata) {
    return Boolean(
        metadata.title
        || metadata.thumbnailUrl
        || metadata.previewUrl
        || metadata.commentCount !== null,
    )
}

function cleanCaptionPart(value: string | null) {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}
