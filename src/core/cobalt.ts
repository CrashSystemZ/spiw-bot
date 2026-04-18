import {basename, extname} from "node:path"
import {setTimeout as sleep} from "node:timers/promises"

import {env} from "../config/env.js"
import type {CobaltEndpoint, CobaltPool} from "./cobalt-pool.js"
import {
    type DomainError,
    MediaTooLargeError,
    MediaUnavailableError,
    UnsupportedLinkError,
} from "./errors.js"
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

const UNSUPPORTED_CODES = new Set([
    "error.api.service.unsupported",
    "error.api.service.disabled",
    "error.api.link.invalid",
    "error.api.link.unsupported",
])

const NOT_FOUND_CODES = new Set([
    "error.api.content.video.unavailable",
    "error.api.content.video.live",
    "error.api.content.video.private",
    "error.api.content.video.age",
    "error.api.content.video.region",
    "error.api.content.post.unavailable",
    "error.api.content.post.private",
    "error.api.content.post.age",
])

const INTERNAL_HOSTNAMES = new Set(["cobalt", "localhost", "127.0.0.1", "::1"])

type EndpointResult =
    | {kind: "success", response: CobaltSuccess}
    | {kind: "content_error", response: CobaltFailure}
    | {kind: "fetch_failed", lastError: CobaltResponse | null}

export class CobaltClient {
    readonly #pool: CobaltPool
    readonly #requestTimeoutMs: number

    constructor(pool: CobaltPool, requestTimeoutMs: number = env.COBALT_REQUEST_TIMEOUT_MS) {
        this.#pool = pool
        this.#requestTimeoutMs = requestTimeoutMs
    }

    async resolve(request: CobaltRequest): Promise<CobaltResponse> {
        const endpoints = this.#pool.endpoints()
        if (endpoints.length === 0)
            throw new MediaUnavailableError("protocol")

        let lastFailure: CobaltResponse | null = null

        for (let epIdx = 0; epIdx < endpoints.length; epIdx++) {
            const endpoint = endpoints[epIdx]!
            const result = await this.#tryEndpoint(endpoint, request)

            if (result.kind === "success")
                return result.response
            if (result.kind === "content_error")
                return result.response

            lastFailure = result.lastError
            const errorCode = extractErrorCode(result.lastError)
            const isLast = epIdx === endpoints.length - 1
            logWarn("cobalt.pool.endpoint_failed", {
                endpoint: endpoint.name,
                errorCode,
                triedEndpoints: epIdx + 1,
                remainingEndpoints: endpoints.length - epIdx - 1,
            })
            if (errorCode && isAuthError(errorCode))
                this.#pool.banEndpoint(endpoint.url, errorCode)
            if (isLast)
                break
        }

        if (lastFailure)
            return lastFailure
        throw new MediaUnavailableError("protocol")
    }

    async fetchBinary(url: string, preferredFileName: string | undefined, maxBytes: number) {
        const attempts = 2
        let lastEmptyError: MediaUnavailableError | null = null
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (attempt > 0)
                await sleep(500)
            try {
                return await this.#fetchBinaryOnce(url, preferredFileName, maxBytes)
            } catch (error) {
               const isEmpty = error instanceof MediaUnavailableError
                    && error.reason === "cobalt_failed"
                    && error.httpStatus === 200
                if (!isEmpty || attempt === attempts - 1)
                    throw error
                lastEmptyError = error
                logWarn("cobalt.fetch_binary.empty_retry", {url, attempt: attempt + 1})
            }
        }
        throw lastEmptyError ?? new MediaUnavailableError("protocol")
    }

    async #fetchBinaryOnce(url: string, preferredFileName: string | undefined, maxBytes: number) {
        logInfo("cobalt.fetch_binary.start", {
            url,
            preferredFileName,
            maxBytes,
        })
        const response = await fetch(url, {
            headers: buildMediaHeaders(resolveEndpointForUrl(url, this.#pool.endpoints())),
            redirect: "follow",
        })

        if (!response.ok) {
            logWarn("cobalt.fetch_binary.http_error", {
                url,
                status: response.status,
                statusText: response.statusText,
            })
            throw new MediaUnavailableError("cobalt_failed", {httpStatus: response.status})
        }

        const lengthHeader = response.headers.get("content-length") ?? response.headers.get("estimated-content-length")
        if (lengthHeader) {
            const expected = Number(lengthHeader)
            if (Number.isFinite(expected) && expected > maxBytes)
                throw new MediaTooLargeError()
        }

        const reader = response.body?.getReader()
        if (!reader)
            throw new MediaUnavailableError("protocol")

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
                throw new MediaTooLargeError()
            }
            chunks.push(chunk)
        }

        const buffer = Buffer.concat(chunks)
        const mimeType = response.headers.get("content-type")
        if (buffer.byteLength === 0) {
            logWarn("cobalt.fetch_binary.empty", {
                url,
                finalUrl: response.url,
                httpStatus: response.status,
                mimeType,
            })
            throw new MediaUnavailableError("cobalt_failed", {httpStatus: response.status})
        }
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

    async #tryEndpoint(endpoint: CobaltEndpoint, request: CobaltRequest): Promise<EndpointResult> {
        const attempts: ReadonlyArray<{alwaysProxy: boolean; delayMs: number}> = [
            {alwaysProxy: false, delayMs: 0},
            {alwaysProxy: true, delayMs: 0},
            {alwaysProxy: true, delayMs: 750},
        ]
        let lastError: CobaltResponse | null = null

        for (let attempt = 0; attempt < attempts.length; attempt++) {
            const {alwaysProxy, delayMs} = attempts[attempt]!
            if (delayMs > 0)
                await sleep(delayMs)

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
            logInfo("cobalt.resolve.request", {...payload, endpoint: endpoint.name})

            const response = await fetchWithTimeout(
                new URL("/", endpoint.url),
                {
                    method: "POST",
                    headers: buildApiHeaders(endpoint),
                    body: JSON.stringify(payload),
                },
                this.#requestTimeoutMs,
            ).catch((error: unknown) => {
                logWarn("cobalt.resolve.network_error", {
                    endpoint: endpoint.name,
                    error: error instanceof Error ? error.message : String(error),
                })
                return null
            })

            if (!response)
                continue

            const body = await response.json().catch(() => null) as CobaltResponse | null
            if (!body || typeof body !== "object" || !("status" in body)) {
                logWarn("cobalt.resolve.bad_body", {endpoint: endpoint.name, httpStatus: response.status})
                if (response.status === 401 || response.status === 403 || response.status === 407) {
                    this.#pool.banEndpoint(endpoint.url, `http_${response.status}`)
                    break
                }
                continue
            }

            logInfo("cobalt.resolve.response", {
                url: request.url,
                endpoint: endpoint.name,
                alwaysProxy,
                httpStatus: response.status,
                status: body.status,
            })

            if (body.status !== "error")
                return {kind: "success", response: normalizeCobaltResponseUrls(body, endpoint)}

            lastError = body
            const code = body.error.code
            if (isContentError(code))
                return {kind: "content_error", response: body}

            const isLastAttempt = attempt === attempts.length - 1
            if (isLastAttempt || !shouldRetryCobaltError(code))
                break

            const nextDelayMs = attempts[attempt + 1]!.delayMs
            logWarn("cobalt.resolve.retrying", {
                url: request.url,
                endpoint: endpoint.name,
                errorCode: code,
                attempt: attempt + 1,
                nextDelayMs,
            })
        }

        return {kind: "fetch_failed", lastError}
    }
}

export function cobaltErrorToDomain(code: string): DomainError {
    if (UNSUPPORTED_CODES.has(code))
        return new UnsupportedLinkError()
    if (code === "error.api.content.too_long")
        return new MediaTooLargeError()
    if (NOT_FOUND_CODES.has(code))
        return new MediaUnavailableError("not_found", {cobaltCode: code})
    return new MediaUnavailableError("cobalt_failed", {cobaltCode: code})
}

function shouldRetryCobaltError(code: string) {
    return code === "error.api.fetch.fail" || code === "error.api.fetch.empty"
}

function isContentError(code: string) {
    return UNSUPPORTED_CODES.has(code) || NOT_FOUND_CODES.has(code) || code === "error.api.content.too_long"
}

function isAuthError(code: string) {
    return code.startsWith("error.api.auth.")
}

function extractErrorCode(response: CobaltResponse | null): string | null {
    if (!response || response.status !== "error")
        return null
    return response.error.code
}

function buildApiHeaders(endpoint: CobaltEndpoint): HeadersInit {
    const headers = new Headers({
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "spiw-bot (+https://github.com/your-org/spiw-bot)",
    })
    if (endpoint.authorization)
        headers.set("Authorization", endpoint.authorization)
    return headers
}

function buildMediaHeaders(endpoint: CobaltEndpoint | null): HeadersInit {
    const headers = new Headers({
        Accept: "*/*",
        "User-Agent": "spiw-bot (+https://github.com/your-org/spiw-bot)",
    })
    if (endpoint?.authorization)
        headers.set("Authorization", endpoint.authorization)
    return headers
}

async function fetchWithTimeout(input: URL | RequestInfo, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(input, {...init, signal: controller.signal})
    } finally {
        clearTimeout(timer)
    }
}

function resolveEndpointForUrl(url: string, endpoints: readonly CobaltEndpoint[]): CobaltEndpoint | null {
    try {
        const host = new URL(url).host
        return endpoints.find(e => {
            try {
                return new URL(e.url).host === host
            } catch {
                return false
            }
        }) ?? null
    } catch {
        return null
    }
}

function normalizeCobaltResponseUrls(response: CobaltSuccess, endpoint: CobaltEndpoint): CobaltSuccess {
    if (response.status === "tunnel" || response.status === "redirect") {
        return {
            ...response,
            url: rewriteCobaltUrl(response.url, endpoint),
        }
    }

    if (response.status === "picker") {
        return {
            ...response,
            audio: response.audio ? rewriteCobaltUrl(response.audio, endpoint) : response.audio,
            picker: response.picker.map(item => ({
                ...item,
                url: rewriteCobaltUrl(item.url, endpoint),
                thumb: item.thumb ? rewriteCobaltUrl(item.thumb, endpoint) : item.thumb,
            })),
        }
    }

    return response
}

function rewriteCobaltUrl(url: string, endpoint: CobaltEndpoint) {
    try {
        const parsed = new URL(url)
        if (!INTERNAL_HOSTNAMES.has(parsed.hostname))
            return url
        const base = new URL(endpoint.url)
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
