import {isCaptionAvailable} from "../../../core/caption-policy.js"
import {logInfo} from "../../../core/log.js"
import {SpiwRuntime} from "../../../core/runtime.js"
import {captionButton} from "../../ui.js"
import {presentAudioMessage, presentMediaMessage} from "../../presenter.js"
import {withInteraction} from "./common.js"

export function registerCaptionCallbackHandler(dp: any, runtime: SpiwRuntime) {
    dp.onAnyCallbackQuery(captionButton.filter(), async (query: any) => {
        logInfo("bot.callback.caption", {token: query.match.token})

        await withInteraction(runtime, query, async (state, session) => {
            const pretty = isCaptionAvailable(session.metadata)
                ? session.metadata
                : await runtime.ensurePrettyMetadata(state.cacheKey)
            const effectiveMetadata = pretty ?? session.metadata

            const nextCaptionVisible = isCaptionAvailable(effectiveMetadata) ? !state.captionVisible : false
            await runtime.saveUiState({
                token: query.match.token,
                cacheKey: state.cacheKey,
                captionVisible: nextCaptionVisible,
                mode: state.mode,
                index: state.index,
            })

            if (state.mode === "audio" && session.audio) {
                await query.editMessage(presentAudioMessage(session, session.audio, {
                    token: query.match.token,
                    index: state.index,
                    captionVisible: nextCaptionVisible,
                    metadata: effectiveMetadata,
                }))
            } else {
                const rendered = presentMediaMessage(session, {
                    token: query.match.token,
                    index: state.index,
                    captionVisible: nextCaptionVisible,
                    metadata: effectiveMetadata,
                })
                if (rendered)
                    await query.editMessage(rendered)
            }
        })
    })
}
