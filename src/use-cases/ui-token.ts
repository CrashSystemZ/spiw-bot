import {SpiwRuntime} from "../core/runtime.js"

export async function registerUiToken(runtime: SpiwRuntime, cacheKey: string, state: {
    captionVisible: boolean
    mode: "media" | "audio"
    index: number
}) {
    const token = cacheKey.slice(0, 16) + Math.random().toString(16).slice(2, 6)
    await runtime.saveUiState({
        token,
        cacheKey,
        captionVisible: state.captionVisible,
        mode: state.mode,
        index: state.index,
    })
    return token
}
