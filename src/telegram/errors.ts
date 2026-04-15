import type {ParsedUpdate, TelegramClient} from "@mtcute/node"
import {tl} from "@mtcute/node"

import {logError, logWarn} from "../core/log.js"
import {messages} from "../core/messages.js"
import {makeErrorResult} from "./ui.js"

export function createDispatcherErrorHandler(client: TelegramClient) {
    return async (error: Error, ctx: ParsedUpdate) => {
        if (
            tl.RpcError.is(error, "MESSAGE_ID_INVALID")
            || tl.RpcError.is(error, "MESSAGE_NOT_MODIFIED")
            || tl.RpcError.is(error, "USER_IS_BLOCKED")
        ) {
            logWarn("telegram.dispatcher.rpc_ignored", {
                update: ctx.name,
                error: error.message,
            })
            return true
        }

        logError("telegram.dispatcher.unhandled_error", error, {
            update: ctx.name,
            rawUpdateType: (ctx as any).raw?._ ?? null,
        })

        if (ctx.name === "inline_query") {
            try {
                await client.answerInlineQuery(ctx.data, [makeErrorResult(`err_${Date.now()}`, messages.tryAgain)], {
                    cacheTime: 0,
                    private: true,
                })
            } catch {
                // noop
            }
            return true
        }

        return true
    }
}
