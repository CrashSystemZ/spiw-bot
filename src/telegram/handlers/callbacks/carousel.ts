import { logDebug, logInfo } from "../../../core/log.js"
import { SpiwRuntime } from "../../../core/runtime.js"
import { carouselButton } from "../../ui.js"
import { presentMediaMessage, summarizeItem } from "../../presenter.js"
import { withInteraction } from "./common.js"

export function registerCarouselCallbackHandler(dp: any, runtime: SpiwRuntime) {
    dp.onAnyCallbackQuery(carouselButton.filter(), async (query: any) => {
        logInfo("bot.callback.carousel", {
            token: query.match.token,
            index: query.match.index,
        })
        await withInteraction(runtime, query, async (state, session) => {
            const index = Number.parseInt(query.match.index, 10)
            const item = session.items[index]
            if (!item)
                return

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
            const rendered = presentMediaMessage(session, {
                token: query.match.token,
                index,
                captionVisible: state.captionVisible,
            })
            if (rendered)
                await query.editMessage(rendered)
        })
    })
}
