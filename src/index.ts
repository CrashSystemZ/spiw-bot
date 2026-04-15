import { logError, logInfo } from "./core/log.js"
import { startBot } from "./telegram/bot.js"

process.on("unhandledRejection", (error) => {
    logError("process.unhandled_rejection", error)
})

process.on("uncaughtException", (error) => {
    logError("process.uncaught_exception", error)
})

logInfo("process.start")
void startBot()
