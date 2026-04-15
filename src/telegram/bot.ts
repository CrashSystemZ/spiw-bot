import {Dispatcher, filters, MemoryStateStorage, PropagationAction} from "@mtcute/dispatcher"
import {BotKeyboard, TelegramClient} from "@mtcute/node"

import {env} from "../config/env.js"
import {logDebug, logError, logInfo, logWarn} from "../core/log.js"
import {messages} from "../core/messages.js"
import type {Platform, SessionEntry} from "../core/models.js"
import {SpiwRuntime} from "../core/runtime.js"
import {DatabaseClient} from "../core/db/client.js"
import {createDispatcherErrorHandler} from "./errors.js"
import {
    audioButton,
    buildAudioModeKeyboard,
    buildPostKeyboard,
    captionButton,
    carouselButton,
    hasCaption,
    makeErrorResult,
    makeLoadingResult,
    photoButton,
    retryButton,
    toAudioMediaWithCaption,
    toInputMediaWithCaption,
} from "./ui.js"

type BotState = Record<string, never>

export async function startBot() {
    logInfo("bot.starting", {
        dbPath: env.DB_PATH,
        sessionPath: env.SESSION_PATH,
        cobaltBaseUrl: env.COBALT_BASE_URL,
    })

    const db = new DatabaseClient(env.DB_PATH)
    const runtime = new SpiwRuntime(db)
    await runtime.init()

    const bot = new TelegramClient({
        apiId: env.TG_API_ID,
        apiHash: env.TG_API_HASH,
        storage: env.SESSION_PATH,
    })

    const dp = Dispatcher.for<BotState>(bot, {
        storage: new MemoryStateStorage(),
    })
    dp.onError(createDispatcherErrorHandler(bot))

    dp.onNewMessage(filters.command("stats"), async (msg: any) => {
        const stats = await runtime.getStats()
        await msg.replyText(
            `${messages.statsTitle}\n\nLast 24h: ${stats.last24Hours}\nAll time: ${stats.allTime}`,
        )
    })

    dp.onInlineQuery(async (query: any) => {
        const rawQuery = query.query.trim()
        logInfo("bot.inline_query.received", {
            userId: query.user?.id ?? null,
            rawQuery,
        })
        if (!rawQuery) {
            await query.answer([], {cacheTime: 0, private: true})
            return
        }

        try {
            const request = await runtime.createInlineRequest(rawQuery, query.user.id)
            logInfo("bot.inline_query.request_created", {
                requestId: request.requestId,
                cacheKey: request.metadata.cacheKey,
                platform: request.metadata.platform,
                normalizedUrl: request.metadata.normalizedUrl,
                title: request.metadata.title,
                description: request.metadata.description,
                commentCount: request.metadata.commentCount,
            })
            await query.answer([makeLoadingResult(request)], {
                cacheTime: 0,
                private: true,
            })
        } catch (error) {
            logError("bot.inline_query.failed", error, {
                userId: query.user?.id ?? null,
                rawQuery,
            })
            const message = error instanceof Error ? error.message : messages.tryAgain
            if (message === messages.unsupportedLink || message.includes("Link not supported")) {
                await query.answer([], {cacheTime: 0, private: true})
                return
            }
            await query.answer([makeErrorResult(`err_${Date.now()}`, message)], {
                cacheTime: 0,
                private: true,
            })
        }
    })

    dp.onChosenInlineResult(async (result: any) => {
        const resultId = typeof result.id === "string"
            ? result.id
            : typeof result.raw?.id === "string"
                ? result.raw.id
                : ""
        logInfo("bot.chosen_inline.received", {
            resultId,
            query: result.query ?? null,
            hasMessageId: Boolean(result.raw?.msgId),
            rawMessageIdType: result.raw?.msgId?._ ?? null,
            userId: result.user?.id ?? null,
        })
        if (typeof resultId !== "string" || !resultId.startsWith("req_"))
            return

        try {
            const {request, session} = await runtime.hydrateSessionForRequest(resultId)
            if (!session.items.length)
                throw new Error(messages.mediaUnavailable)

            const initialMessage = await resolveInitialMessageState(runtime, session)
            const token = await registerToken(runtime, session.cacheKey, {
                captionVisible: initialMessage.captionVisible,
                mode: "media",
                index: 0,
            })
            const replyMarkup = session.items.length > 1
                ? buildPostKeyboard(initialMessage.metadata, {
                    token,
                    currentIndex: 0,
                    totalItems: session.items.length,
                    hasAudio: !!session.audio,
                })
                : buildPostKeyboard(initialMessage.metadata, {token})

            logInfo("bot.chosen_inline.edit_media", {
                requestId: request.id,
                cacheKey: session.cacheKey,
                itemCount: session.items.length,
                firstItem: summarizeItem(session.items[0]),
                hasAudio: Boolean(session.audio),
                replyMarkupRows: countReplyMarkupRows(replyMarkup),
            })
            await result.editMessage({
                media: toInputMediaWithCaption(session.items[0]!, initialMessage.metadata, initialMessage.captionVisible),
                replyMarkup,
            })
            logInfo("bot.chosen_inline.edit_media.ok", {
                requestId: request.id,
                cacheKey: session.cacheKey,
            })

            await runtime.recordDeliveredItems(session)
            await runtime.finishRequest(request.id)
        } catch (error) {
            logError("bot.chosen_inline.failed", error, {
                resultId,
                query: result.query ?? null,
            })
            const message = error instanceof Error ? error.message : messages.tryAgain
            try {
                await result.editMessage({
                    text: message,
                    replyMarkup: undefined,
                })
                logWarn("bot.chosen_inline.error_message_set", {
                    resultId,
                    message,
                })
            } catch {
                // noop
            }
        }
    })

    dp.onAnyCallbackQuery(async (query: any) => {
        const data = typeof query.dataStr === "string" ? query.dataStr : ""
        logInfo("bot.callback.received", {
            data,
            inlineMessageIdType: query.raw?.msgId?._ ?? null,
            userId: query.user?.id ?? null,
        })
        if (data.startsWith("noop:")) {
            await query.answer({})
            return
        }

        return PropagationAction.Continue
    })

    dp.onAnyCallbackQuery(carouselButton.filter(), async (query: any) => {
        const state = await runtime.getUiState(query.match.token)
        logInfo("bot.callback.carousel", {
            token: query.match.token,
            index: query.match.index,
            cacheKey: state?.cacheKey ?? null,
        })
        if (!state) {
            await query.answer({text: messages.carouselExpired})
            return
        }

        const session = await runtime.hydrateSessionFromCacheKey(state.cacheKey).catch(() => null)
        if (!session) {
            await runtime.deleteUiState(query.match.token)
            await query.answer({text: messages.carouselExpired})
            return
        }

        const index = Number.parseInt(query.match.index, 10)
        const item = session.items[index]
        if (!item) {
            await query.answer({})
            return
        }

        await runtime.saveUiState({
            token: query.match.token,
            cacheKey: state.cacheKey,
            captionVisible: state.captionVisible,
            mode: "media",
            index,
        })

        logDebug("bot.callback.carousel.edit_media", {
            cacheKey: state.cacheKey,
            index,
            item: summarizeItem(item),
            hasAudio: Boolean(session.audio),
            totalItems: session.items.length,
        })
        await query.editMessage({
            media: toInputMediaWithCaption(item, session.metadata, state.captionVisible),
            replyMarkup: buildPostKeyboard(session.metadata, {
                token: query.match.token,
                currentIndex: index,
                totalItems: session.items.length,
                hasAudio: !!session.audio,
            }),
        })
        await query.answer({})
    })

    dp.onAnyCallbackQuery(audioButton.filter(), async (query: any) => {
        const state = await runtime.getUiState(query.match.token)
        logInfo("bot.callback.audio", {
            token: query.match.token,
            index: query.match.index,
            cacheKey: state?.cacheKey ?? null,
        })
        if (!state) {
            await query.answer({text: messages.carouselExpired})
            return
        }

        const session = await runtime.hydrateSessionFromCacheKey(state.cacheKey).catch(() => null)
        if (!session?.audio) {
            await runtime.deleteUiState(query.match.token)
            await query.answer({text: messages.carouselExpired})
            return
        }

        const photoIndex = Number.parseInt(query.match.index, 10)
        await runtime.saveUiState({
            token: query.match.token,
            cacheKey: state.cacheKey,
            captionVisible: state.captionVisible,
            mode: "audio",
            index: Number.isFinite(photoIndex) ? photoIndex : 0,
        })
        await query.editMessage({
            media: toAudioMediaWithCaption(session.audio, session.metadata, state.captionVisible),
            replyMarkup: buildAudioModeKeyboard(session.metadata, query.match.token, Number.isFinite(photoIndex) ? photoIndex : 0),
        })
        await query.answer({})
    })

    dp.onAnyCallbackQuery(photoButton.filter(), async (query: any) => {
        const state = await runtime.getUiState(query.match.token)
        logInfo("bot.callback.photo", {
            token: query.match.token,
            index: query.match.index,
            cacheKey: state?.cacheKey ?? null,
        })
        if (!state) {
            await query.answer({text: messages.carouselExpired})
            return
        }

        const session = await runtime.hydrateSessionFromCacheKey(state.cacheKey).catch(() => null)
        if (!session) {
            await runtime.deleteUiState(query.match.token)
            await query.answer({text: messages.carouselExpired})
            return
        }

        const index = Number.parseInt(query.match.index, 10)
        const item = session.items[index] ?? session.items[0]
        if (!item) {
            await query.answer({text: messages.carouselExpired})
            return
        }

        await runtime.saveUiState({
            token: query.match.token,
            cacheKey: state.cacheKey,
            captionVisible: state.captionVisible,
            mode: "media",
            index: index >= 0 ? index : 0,
        })

        await query.editMessage({
            media: toInputMediaWithCaption(item, session.metadata, state.captionVisible),
            replyMarkup: buildPostKeyboard(session.metadata, {
                token: query.match.token,
                currentIndex: index >= 0 ? index : 0,
                totalItems: session.items.length,
                hasAudio: !!session.audio,
            }),
        })
        await query.answer({})
    })

    dp.onAnyCallbackQuery(captionButton.filter(), async (query: any) => {
        const state = await runtime.getUiState(query.match.token)
        logInfo("bot.callback.caption", {
            token: query.match.token,
            cacheKey: state?.cacheKey ?? null,
            captionVisible: state?.captionVisible ?? null,
            mode: state?.mode ?? null,
            index: state?.index ?? null,
        })
        if (!state) {
            await query.answer({text: messages.carouselExpired})
            return
        }

        const session = await runtime.hydrateSessionFromCacheKey(state.cacheKey).catch(() => null)
        if (!session) {
            await runtime.deleteUiState(query.match.token)
            await query.answer({text: messages.carouselExpired})
            return
        }

        const pretty = hasCaption(session.metadata) ? session.metadata : await runtime.ensurePrettyMetadata(state.cacheKey)
        const effectiveMetadata = pretty ?? session.metadata
        if (!hasCaption(effectiveMetadata)) {
            await runtime.saveUiState({
                token: query.match.token,
                cacheKey: state.cacheKey,
                captionVisible: false,
                mode: state.mode,
                index: state.index,
            })
            const item = session.items[state.index] ?? session.items[0]
            if (state.mode === "audio" && session.audio) {
                await query.editMessage({
                    media: toAudioMediaWithCaption(session.audio, effectiveMetadata, false),
                    replyMarkup: buildAudioModeKeyboard(effectiveMetadata, query.match.token, state.index),
                })
            } else if (item) {
                await query.editMessage({
                    media: toInputMediaWithCaption(item, effectiveMetadata, false),
                    replyMarkup: buildPostKeyboard(effectiveMetadata, {
                        token: query.match.token,
                        currentIndex: state.index,
                        totalItems: session.items.length,
                        hasAudio: !!session.audio,
                    }),
                })
            }
            await query.answer({})
            return
        }

        const nextState = {
            ...state,
            captionVisible: !state.captionVisible,
        }
        await runtime.saveUiState({
            token: query.match.token,
            cacheKey: nextState.cacheKey,
            captionVisible: nextState.captionVisible,
            mode: nextState.mode,
            index: nextState.index,
        })

        if (nextState.mode === "audio" && session.audio) {
            await query.editMessage({
                media: toAudioMediaWithCaption(session.audio, effectiveMetadata, nextState.captionVisible),
                replyMarkup: buildAudioModeKeyboard(effectiveMetadata, query.match.token, nextState.index),
            })
            await query.answer({})
            return
        }

        const item = session.items[nextState.index] ?? session.items[0]
        if (!item) {
            await query.answer({})
            return
        }

        await query.editMessage({
            media: toInputMediaWithCaption(item, effectiveMetadata, nextState.captionVisible),
            replyMarkup: buildPostKeyboard(effectiveMetadata, {
                token: query.match.token,
                currentIndex: nextState.index,
                totalItems: session.items.length,
                hasAudio: !!session.audio,
            }),
        })
        await query.answer({})
    })

    dp.onAnyCallbackQuery(retryButton.filter(), async (query: any) => {
        const state = await runtime.getUiState(query.match.token)
        logInfo("bot.callback.retry", {
            token: query.match.token,
            cacheKey: state?.cacheKey ?? null,
        })
        if (!state) {
            await query.answer({text: messages.retryExpired})
            return
        }

        await query.answer({text: messages.retryStarted})
        try {
            const session = await runtime.hydrateSessionFromCacheKey(state.cacheKey)
            const initialMessage = await resolveInitialMessageState(runtime, session)
            const token = await registerToken(runtime, session.cacheKey, {
                captionVisible: initialMessage.captionVisible,
                mode: "media",
                index: 0,
            })
            await query.editMessage({
                media: toInputMediaWithCaption(session.items[0]!, initialMessage.metadata, initialMessage.captionVisible),
                replyMarkup: session.items.length > 1
                    ? buildPostKeyboard(initialMessage.metadata, {
                        token,
                        currentIndex: 0,
                        totalItems: session.items.length,
                        hasAudio: !!session.audio,
                    })
                    : buildPostKeyboard(initialMessage.metadata, {token}),
            })
        } catch (error) {
            logError("bot.callback.retry.failed", error, {
                cacheKey: state.cacheKey,
            })
            const message = error instanceof Error ? error.message : messages.tryAgain
            await query.editMessage({
                text: message,
                replyMarkup: await buildRetryMarkup(runtime, state.cacheKey),
            })
        }
    })

    await bot.start({botToken: env.BOT_TOKEN})
    logInfo("bot.started", {
        cobaltBaseUrl: env.COBALT_BASE_URL,
    })
}

async function registerToken(runtime: SpiwRuntime, cacheKey: string, state: {
    captionVisible: boolean
    mode: "media" | "audio"
    index: number
}) {
    const token = cacheKey.slice(0, 16) + Math.random().toString(16).slice(2, 6)
    await runtime.saveUiState({
        token,
        cacheKey,
        captionVisible: state.captionVisible,
        mode: state.mode,
        index: state.index,
    })
    return token
}

async function buildRetryMarkup(runtime: SpiwRuntime, cacheKey: string) {
    const token = await registerToken(runtime, cacheKey, {
        captionVisible: false,
        mode: "media",
        index: 0,
    })
    return BotKeyboard.inline([
        [BotKeyboard.callback("🔄 Retry", retryButton.build({token}))],
    ])
}

function summarizeItem(item: any) {
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

function countReplyMarkupRows(replyMarkup: any) {
    return Array.isArray(replyMarkup?.buttons) ? replyMarkup.buttons.length : 0
}

async function resolveInitialMessageState(runtime: SpiwRuntime, session: SessionEntry) {
    let metadata = session.metadata

    if (shouldShowCaptionByDefault(metadata.platform) && !hasCaption(metadata)) {
        const pretty = await runtime.ensurePrettyMetadata(session.cacheKey)
        if (pretty)
            metadata = pretty
    }

    return {
        metadata,
        captionVisible: shouldShowCaptionByDefault(metadata.platform) && hasCaption(metadata),
    }
}

function shouldShowCaptionByDefault(platform: Platform) {
    return platform === "x" || platform === "threads"
}
