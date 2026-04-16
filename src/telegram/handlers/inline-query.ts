import { logError, logInfo } from "../../core/log.js"
import { SpiwRuntime } from "../../core/runtime.js"
import { presentErrorInlineResult, presentLoadingInlineResult } from "../presenter.js"
import { prepareInlineRequest } from "../../use-cases/prepare-inline-request.js"

export function registerInlineQueryHandler(dp: any, runtime: SpiwRuntime) {
    dp.onInlineQuery(async (query: any) => {
        const rawQuery = query.query.trim()
        logInfo("bot.inline_query.received", {
            userId: query.user?.id ?? null,
            rawQuery,
        })

        const result = await prepareInlineRequest(runtime, rawQuery, query.user.id).catch((error) => {
            logError("bot.inline_query.failed", error, {
                userId: query.user?.id ?? null,
                rawQuery,
            })
            return { kind: "error", message: error instanceof Error ? error.message : "Something went wrong" } as const
        })

        switch (result.kind) {
            case "empty":
                await query.answer([], { cacheTime: 0, private: true })
                return
            case "unsupported":
                await query.answer([], { cacheTime: 0, private: true })
                return
            case "error":
                await query.answer([presentErrorInlineResult(`err_${Date.now()}`, result.message)], {
                    cacheTime: 0,
                    private: true,
                })
                return
            case "loading":
                logInfo("bot.inline_query.request_created", {
                    requestId: result.request.requestId,
                    cacheKey: result.request.metadata.cacheKey,
                    platform: result.request.metadata.platform,
                    normalizedUrl: result.request.metadata.normalizedUrl,
                    title: result.request.metadata.title,
                    description: result.request.metadata.description,
                    commentCount: result.request.metadata.commentCount,
                })
                await query.answer([presentLoadingInlineResult(result.request)], {
                    cacheTime: 0,
                    private: true,
                })
        }
    })
}
