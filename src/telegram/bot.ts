import { Dispatcher, MemoryStateStorage } from "@mtcute/dispatcher"
import { TelegramClient } from "@mtcute/node"

import { env } from "../config/env.js"
import { DatabaseClient } from "../core/db/client.js"
import { logInfo } from "../core/log.js"
import { SpiwRuntime } from "../core/runtime.js"
import { createDispatcherErrorHandler } from "./errors.js"
import { registerCallbackHandlers } from "./handlers/callbacks.js"
import { registerChosenInlineHandler } from "./handlers/chosen-inline.js"
import { registerInlineQueryHandler } from "./handlers/inline-query.js"
import { registerStatsHandler } from "./handlers/stats.js"

type BotState = Record<string, never>

export type BotHandle = {
    stop: () => Promise<void>
}

export async function startBot(): Promise<BotHandle> {
    logInfo("bot.starting", {
        dbPath: env.DB_PATH,
        sessionPath: env.SESSION_PATH,
        cobaltBaseUrl: env.COBALT_BASE_URL,
    })

    const db = DatabaseClient.create(env.DB_PATH)
    const runtime = new SpiwRuntime(db)
    runtime.start()

    const bot = new TelegramClient({
        apiId: env.TG_API_ID,
        apiHash: env.TG_API_HASH,
        storage: env.SESSION_PATH,
    })

    const dp = Dispatcher.for<BotState>(bot, {
        storage: new MemoryStateStorage(),
    })
    dp.onError(createDispatcherErrorHandler(bot))

    registerStatsHandler(dp, runtime)
    registerInlineQueryHandler(dp, runtime)
    registerChosenInlineHandler(dp, runtime)
    registerCallbackHandlers(dp, runtime)

    await bot.start({ botToken: env.BOT_TOKEN })
    logInfo("bot.started", {
        cobaltBaseUrl: env.COBALT_BASE_URL,
    })

    return {
        stop: async () => {
            logInfo("bot.stopping")
            await dp.destroy()
            await bot.destroy()
            await runtime.dispose()
            logInfo("bot.stopped")
        },
    }
}
