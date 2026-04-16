import { logError, logInfo, logWarn } from "../../core/log.js"
import { SpiwRuntime } from "../../core/runtime.js"
import { messages } from "../../core/messages.js"
import { deliverInlineRequest } from "../../use-cases/deliver-inline-request.js"
import { registerUiToken } from "../../use-cases/ui-token.js"
import { countReplyMarkupRows, presentMediaMessage, summarizeItem } from "../presenter.js"

export function registerChosenInlineHandler(dp: any, runtime: SpiwRuntime) {
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
            const delivered = await deliverInlineRequest(runtime, resultId)
            const token = await registerUiToken(runtime, delivered.session.cacheKey, {
                captionVisible: delivered.initialMessage.captionVisible,
                mode: "media",
                index: 0,
            })
            const rendered = presentMediaMessage(delivered.session, {
                token,
                index: 0,
                captionVisible: delivered.initialMessage.captionVisible,
                metadata: delivered.initialMessage.metadata,
            })
            if (!rendered)
                throw new Error(messages.mediaUnavailable)

            logInfo("bot.chosen_inline.edit_media", {
                requestId: delivered.request.id,
                cacheKey: delivered.session.cacheKey,
                itemCount: delivered.session.items.length,
                firstItem: summarizeItem(delivered.session.items[0]),
                hasAudio: Boolean(delivered.session.audio),
                replyMarkupRows: countReplyMarkupRows(rendered.replyMarkup),
            })
            await result.editMessage(rendered)
            logInfo("bot.chosen_inline.edit_media.ok", {
                requestId: delivered.request.id,
                cacheKey: delivered.session.cacheKey,
            })

            await runtime.recordDeliveredItems(delivered.session)
            await runtime.finishRequest(delivered.request.id)
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
}
