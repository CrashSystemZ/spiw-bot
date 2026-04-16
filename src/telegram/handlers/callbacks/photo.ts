import { logInfo } from "../../../core/log.js"
import { messages } from "../../../core/messages.js"
import { SpiwRuntime } from "../../../core/runtime.js"
import { photoButton } from "../../ui.js"
import { presentMediaMessage } from "../../presenter.js"
import { withInteraction } from "./common.js"

export function registerPhotoCallbackHandler(dp: any, runtime: SpiwRuntime) {
    dp.onAnyCallbackQuery(photoButton.filter(), async (query: any) => {
        logInfo("bot.callback.photo", {
            token: query.match.token,
            index: query.match.index,
        })

        await withInteraction(runtime, query, async (state, session) => {
            const parsedIndex = Number.parseInt(query.match.index, 10)
            const index = parsedIndex >= 0 ? parsedIndex : 0
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
                index,
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
