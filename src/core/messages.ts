import {readFileSync} from "node:fs"
import {dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"

export type MessageKey =
    | "loading"
    | "carouselExpired"
    | "retryExpired"
    | "retryStarted"
    | "unsupportedLink"
    | "mediaTooLarge"
    | "mediaUnavailable"
    | "localProcessingUnsupported"
    | "tryAgain"
    | "clickToSend"
    | "statsTitle"

const REQUIRED_KEYS: MessageKey[] = [
    "loading",
    "carouselExpired",
    "retryExpired",
    "retryStarted",
    "unsupportedLink",
    "mediaTooLarge",
    "mediaUnavailable",
    "localProcessingUnsupported",
    "tryAgain",
    "clickToSend",
    "statsTitle",
]

function loadMessages(): Readonly<Record<MessageKey, string>> {
    const here = dirname(fileURLToPath(import.meta.url))
    // dist/core/messages.js or src/core/messages.ts → ../../resources/messages.json
    const resourcePath = resolve(here, "../../resources/messages.json")
    const raw = JSON.parse(readFileSync(resourcePath, "utf8")) as Record<string, unknown>

    for (const key of REQUIRED_KEYS) {
        const value = raw[key]
        if (typeof value !== "string" || !value)
            throw new Error(`messages.json: missing or empty key "${key}"`)
    }

    return raw as Readonly<Record<MessageKey, string>>
}

export const messages = loadMessages()
