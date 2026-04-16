import { logError, logInfo } from "../../../core/log.js"
import { messages } from "../../../core/messages.js"
import { SpiwRuntime } from "../../../core/runtime.js"
import { retryButton } from "../../ui.js"
import { retryInlineDelivery } from "../../../use-cases/deliver-inline-request.js"
import { registerUiToken } from "../../../use-cases/ui-token.js"
import { presentMediaMessage, presentRetryMarkup } from "../../presenter.js"

export function registerRetryCallbackHandler(dp: any, runtime: SpiwRuntime) {
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
            const {session, initialMessage} = await retryInlineDelivery(runtime, state.cacheKey)
            const token = await registerUiToken(runtime, session.cacheKey, {
                captionVisible: initialMessage.captionVisible,
                mode: "media",
                index: 0,
            })
            const rendered = presentMediaMessage(session, {
                token,
                index: 0,
                captionVisible: initialMessage.captionVisible,
                metadata: initialMessage.metadata,
            })
            if (!rendered)
                throw new Error(messages.mediaUnavailable)
            await query.editMessage(rendered)
        } catch (error) {
            logError("bot.callback.retry.failed", error, {
                cacheKey: state.cacheKey,
            })
            const message = error instanceof Error ? error.message : messages.tryAgain
            const retryToken = await registerUiToken(runtime, state.cacheKey, {
                captionVisible: false,
                mode: "media",
                index: 0,
            })
            await query.editMessage({
                text: message,
                replyMarkup: presentRetryMarkup(retryToken),
            })
        }
    })
}
