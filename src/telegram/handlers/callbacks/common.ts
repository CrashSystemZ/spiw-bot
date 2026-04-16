import { PropagationAction } from "@mtcute/dispatcher"

import { logInfo } from "../../../core/log.js"
import { messages } from "../../../core/messages.js"
import { SpiwRuntime } from "../../../core/runtime.js"
import type { SessionEntry, UiStateRecord } from "../../../core/models.js"

export type LoadedInteraction = {
    state: UiStateRecord | null
    session: SessionEntry | null
}

export function registerBaseCallbackHandler(dp: any) {
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
}

export async function loadInteraction(runtime: SpiwRuntime, token: string): Promise<LoadedInteraction> {
    const state = await runtime.getUiState(token)
    if (!state)
        return {state: null, session: null}

    const session = await runtime.hydrateSessionFromCacheKey(state.cacheKey).catch(() => null)
    if (!session) {
        await runtime.deleteUiState(token)
        return {state: null, session: null}
    }

    return {state, session}
}

export async function withInteraction(
    runtime: SpiwRuntime,
    query: any,
    handler: (state: UiStateRecord, session: SessionEntry) => Promise<void>,
) {
    const interaction = await loadInteraction(runtime, query.match.token)
    if (!interaction.state || !interaction.session) {
        await query.answer({text: messages.carouselExpired})
        return
    }
    await handler(interaction.state, interaction.session)
    await query.answer({})
}
