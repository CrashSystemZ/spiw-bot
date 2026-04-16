import {filters} from "@mtcute/dispatcher"

import {messages} from "../../core/messages.js"
import {SpiwRuntime} from "../../core/runtime.js"

export function registerStatsHandler(dp: any, runtime: SpiwRuntime) {
    dp.onNewMessage(filters.command("stats"), async (msg: any) => {
        const stats = runtime.getStats()
        await msg.replyText(
            `${messages.statsTitle}\n\nLast 24h: ${stats.last24Hours}\nAll time: ${stats.allTime}`,
        )
    })
}
