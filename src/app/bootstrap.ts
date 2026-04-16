import { logError, logInfo, logWarn } from "../core/log.js"
import { startBot, type BotHandle } from "../telegram/bot.js"

const SHUTDOWN_TIMEOUT_MS = 8000

export function installProcessHandlers() {
    process.on("unhandledRejection", (error) => {
        logError("process.unhandled_rejection", error)
    })

    process.on("uncaughtException", (error) => {
        logError("process.uncaught_exception", error)
    })
}

function installShutdownHandlers(handle: BotHandle) {
    let shuttingDown = false

    const shutdown = (signal: string) => {
        if (shuttingDown)
            return
        shuttingDown = true
        logInfo("process.shutdown.start", { signal })

        const hardExit = setTimeout(() => {
            logWarn("process.shutdown.timeout", { timeoutMs: SHUTDOWN_TIMEOUT_MS })
            process.exit(1)
        }, SHUTDOWN_TIMEOUT_MS)
        hardExit.unref()

        handle.stop()
            .then(() => {
                clearTimeout(hardExit)
                process.exit(0)
            })
            .catch((error) => {
                clearTimeout(hardExit)
                logError("process.shutdown.failed", error)
                process.exit(1)
            })
    }

    process.once("SIGTERM", () => shutdown("SIGTERM"))
    process.once("SIGINT", () => shutdown("SIGINT"))
}

export function bootstrap() {
    installProcessHandlers()
    logInfo("process.start")
    startBot()
        .then(installShutdownHandlers)
        .catch((error) => {
            logError("process.start.failed", error)
            process.exit(1)
        })
}
