import { logInfo } from "../../../core/log.js"
import { messages } from "../../../core/messages.js"
import { SpiwRuntime } from "../../../core/runtime.js"
import { audioButton } from "../../ui.js"
import { presentAudioMessage } from "../../presenter.js"
import { withInteraction } from "./common.js"

export function registerAudioCallbackHandler(dp: any, runtime: SpiwRuntime) {
    dp.onAnyCallbackQuery(audioButton.filter(), async (query: any) => {
        logInfo("bot.callback.audio", {
            token: query.match.token,
            index: query.match.index,
        })

        await withInteraction(runtime, query, async (state, session) => {
            if (!session.audio) {
                await query.answer({text: messages.carouselExpired})
                return
            }

            const photoIndex = Number.parseInt(query.match.index, 10)
            const index = Number.isFinite(photoIndex) ? photoIndex : 0
            await runtime.saveUiState({
                token: query.match.token,
                cacheKey: state.cacheKey,
                captionVisible: state.captionVisible,
                mode: "audio",
                index,
            })

            await query.editMessage(presentAudioMessage(session, session.audio, {
                token: query.match.token,
                index,
                captionVisible: state.captionVisible,
            }))
        })
    })
}
