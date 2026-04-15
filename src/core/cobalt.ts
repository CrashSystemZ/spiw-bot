import {basename, extname} from "node:path"

import {env} from "../config/env.js"
import {logInfo, logWarn} from "./log.js"
import type {MediaKind} from "./models.js"

export type CobaltRequest = {
    url: string
    downloadMode?: "auto" | "audio"
}

export type CobaltSuccess =
    | { status: "tunnel" | "redirect", url: string, filename: string }
    | {
    status: "picker",
    audio?: string,
    audioFilename?: string,
    picker: Array<{ type: "photo" | "video" | "gif", url: string, thumb?: string }>
}
    | { status: "local-processing", type: string, service: string, tunnel: string[] }

export type CobaltFailure = {
    status: "error"
    error: {
        code: string
        context?: Record<string, unknown>
    }
}

export type CobaltResponse = CobaltSuccess | CobaltFailure

export type DownloadedBinary = {
    buffer: Buffer
    fileName: string
    mimeType: string | null
    sizeBytes: number
}

const errorMap = new Map<string, string>([
    ["error.api.service.unsupported", "Link not supported 😩"],
    ["error.api.service.disabled", "Link not supported 😩"],
    ["error.api.link.invalid", "Link not supported 😩"],
    ["error.api.link.unsupported", "Link not supported 😩"],
    ["error.api.content.too_long", "This media is too large 👀"],
    ["error.api.content.video.unavailable", "Failed to get media 😵‍💫"],
    ["error.api.content.video.live", "Failed to get media 😵‍💫"],
    ["error.api.content.video.private", "Failed to get media 😵‍💫"],
    ["error.api.content.video.age", "Failed to get media 😵‍💫"],
    ["error.api.content.video.region", "Failed to get media 😵‍💫"],
    ["error.api.content.post.unavailable", "Failed to get media 😵‍💫"],
    ["error.api.content.post.private", "Failed to get media 😵‍💫"],
    ["error.api.content.post.age", "Failed to get media 😵‍💫"],
])

export class CobaltClient {
    readonly #apiHeaders: HeadersInit
    readonly #mediaHeaders: HeadersInit

    constructor() {
        const apiHeaders = new Headers({
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": "spiw-bot (+https://github.com/your-org/spiw-bot)",
        })
        if (env.COBALT_AUTHORIZATION)
            apiHeaders.set("Authorization", env.COBALT_AUTHORIZATION)

        const mediaHeaders = new Headers({
            Accept: "*/*",
            "User-Agent": "spiw-bot (+https://github.com/your-org/spiw-bot)",
        })
        if (env.COBALT_AUTHORIZATION)
            mediaHeaders.set("Authorization", env.COBALT_AUTHORIZATION)

        this.#apiHeaders = apiHeaders
        this.#mediaHeaders = mediaHeaders
    }

    async resolve(request: CobaltRequest): Promise<CobaltResponse> {
        const attempts = [false, true]
        let lastError: CobaltResponse | null = null

        for (const alwaysProxy of attempts) {
            const payload = {
                url: request.url,
                downloadMode: request.downloadMode ?? "auto",
                filenameStyle: "basic",
                videoQuality: "1080",
                youtubeVideoCodec: "h264",
                allowH265: false,
                audioFormat: "best",
                audioBitrate: "128",
                alwaysProxy,
                localProcessing: "disabled",
            }
            logInfo("cobalt.resolve.request", payload)

            const response = await fetch(new URL("/", env.COBALT_BASE_URL), {
                method: "POST",
                headers: this.#apiHeaders,
                body: JSON.stringify(payload),
            })

            const body = await response.json().catch(() => null) as CobaltResponse | null
            if (!body || typeof body !== "object" || !("status" in body))
                throw new Error("Invalid cobalt response")

            logInfo("cobalt.resolve.response", {
                url: request.url,
                alwaysProxy,
                httpStatus: response.status,
                body,
            })

            if (body.status !== "error")
                return normalizeCobaltResponseUrls(body)

            lastError = body
            if (!shouldRetryCobaltError(body.error.code, alwaysProxy)) {
                break
            }

            logWarn("cobalt.resolve.retrying", {
                url: request.url,
                errorCode: body.error.code,
                attemptedAlwaysProxy: alwaysProxy,
            })
        }

        if (lastError)
            return lastError
        throw new Error("Invalid cobalt response")
    }

    async fetchBinary(url: string, preferredFileName: string | undefined, maxBytes: number) {
        logInfo("cobalt.fetch_binary.start", {
            url,
            preferredFileName,
            maxBytes,
        })
        const response = await fetch(url, {
            headers: this.#mediaHeaders,
            redirect: "follow",
        })

        if (!response.ok) {
            logWarn("cobalt.fetch_binary.http_error", {
                url,
                status: response.status,
                statusText: response.statusText,
            })
            throw new Error(`Failed to fetch media: ${response.status}`)
        }

        const lengthHeader = response.headers.get("content-length") ?? response.headers.get("estimated-content-length")
        if (lengthHeader) {
            const expected = Number(lengthHeader)
            if (Number.isFinite(expected) && expected > maxBytes)
                throw new Error("This media is too large 👀")
        }

        const reader = response.body?.getReader()
        if (!reader)
            throw new Error("Failed to open media stream")

        const chunks: Buffer[] = []
        let total = 0

        while (true) {
            const {done, value} = await reader.read()
            if (done)
                break
            const chunk = Buffer.from(value)
            total += chunk.byteLength
            if (total > maxBytes) {
                await reader.cancel("max size exceeded")
                throw new Error("This media is too large 👀")
            }
            chunks.push(chunk)
        }

        const buffer = Buffer.concat(chunks)
        const mimeType = response.headers.get("content-type")
        logInfo("cobalt.fetch_binary.ok", {
            url,
            finalUrl: response.url,
            fileName: pickFileName(response, url, preferredFileName),
            mimeType,
            sizeBytes: buffer.byteLength,
        })
        return {
            buffer,
            mimeType,
            fileName: pickFileName(response, url, preferredFileName),
            sizeBytes: buffer.byteLength,
        } satisfies DownloadedBinary
    }
}

export function mapCobaltError(code: string) {
    if (code.startsWith("error.api.fetch."))
        return "Something went wrong, try again later 🧠"
    return errorMap.get(code) ?? `Something went wrong, try again later 🧠 [${code}]`
}

function shouldRetryCobaltError(code: string, alwaysProxy: boolean) {
    return !alwaysProxy && code === "error.api.fetch.fail";
}

function normalizeCobaltResponseUrls(response: CobaltSuccess): CobaltSuccess {
    if (response.status === "tunnel" || response.status === "redirect") {
        return {
            ...response,
            url: rewriteCobaltUrl(response.url),
        }
    }

    if (response.status === "picker") {
        return {
            ...response,
            audio: response.audio ? rewriteCobaltUrl(response.audio) : response.audio,
            picker: response.picker.map(item => ({
                ...item,
                url: rewriteCobaltUrl(item.url),
                thumb: item.thumb ? rewriteCobaltUrl(item.thumb) : item.thumb,
            })),
        }
    }

    return response
}

function rewriteCobaltUrl(url: string) {
    try {
        const parsed = new URL(url)
        if (parsed.hostname !== "cobalt")
            return url
        const base = new URL(env.COBALT_BASE_URL)
        parsed.protocol = base.protocol
        parsed.hostname = base.hostname
        parsed.port = base.port
        return parsed.toString()
    } catch {
        return url
    }
}

export function inferMediaKind(fileName: string, mimeType: string | null, hintedKind?: MediaKind | "gif"): MediaKind {
    if (hintedKind === "gif")
        return "animation"
    if (hintedKind)
        return hintedKind

    const mime = (mimeType ?? "").toLowerCase()
    const ext = extname(fileName).toLowerCase()
    if (mime.startsWith("image/")) {
        if (mime === "image/gif" || ext === ".gif")
            return "animation"
        return "photo"
    }
    if (mime.startsWith("audio/"))
        return "audio"
    if (mime.startsWith("video/")) {
        if (mime.includes("gif"))
            return "animation"
        return "video"
    }
    if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext))
        return "photo"
    if (ext === ".gif")
        return "animation"
    if ([".mp4", ".mov", ".m4v", ".webm"].includes(ext))
        return "video"
    if ([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav"].includes(ext))
        return "audio"
    return "document"
}

function pickFileName(response: Response, url: string, preferred?: string) {
    const fromHeader = response.headers.get("content-disposition")
    if (fromHeader) {
        const match = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(fromHeader)
        if (match?.[1])
            return decodeURIComponent(match[1].replace(/"/g, ""))
    }
    if (preferred)
        return preferred
    const pathname = new URL(url).pathname
    const base = basename(pathname)
    return base || "media"
}
