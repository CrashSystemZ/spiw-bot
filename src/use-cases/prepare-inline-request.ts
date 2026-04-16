import {UnsupportedLinkError} from "../core/errors.js"
import type {InlineRequestContext} from "../core/models.js"
import {SpiwRuntime} from "../core/runtime.js"
import {renderUserError} from "../telegram/user-errors.js"

export type PrepareInlineRequestResult =
    | { kind: "empty" }
    | { kind: "unsupported" }
    | { kind: "loading", request: InlineRequestContext }
    | { kind: "error", message: string }

export async function prepareInlineRequest(
    runtime: SpiwRuntime,
    rawQuery: string,
    userId: number,
): Promise<PrepareInlineRequestResult> {
    const query = rawQuery.trim()
    if (!query)
        return {kind: "empty"}

    try {
        const request = await runtime.createInlineRequest(query, userId)
        return {
            kind: "loading",
            request,
        }
    } catch (error) {
        if (error instanceof UnsupportedLinkError)
            return {kind: "unsupported"}
        return {
            kind: "error",
            message: renderUserError(error),
        }
    }
}
