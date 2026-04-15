import {env} from "../config/env.js"

type LogLevel = "debug" | "info" | "warn" | "error"

const levelOrder: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
}

const levelLabel: Record<LogLevel, string> = {
    debug: "[DEBUG]",
    info: "[INFO]",
    warn: "[WARN]",
    error: "[ERROR]",
}

const levelColor: Record<LogLevel, string> = {
    debug: "\u001b[90m",
    info: "\u001b[37m",
    warn: "\u001b[38;5;208m",
    error: "\u001b[31m",
}

const resetColor = "\u001b[0m"

const suppressedEvents = new Set<string>([
    "bot.callback.received",
    "bot.inline_query.request_created",
    "runtime.delivery.recorded",
    "runtime.session.job_reuse",
    "runtime.cleanup.requests",
    "runtime.cleanup.five_day",
    "runtime.session.cobalt_response",
    "bot.token.registered",
])

export function logDebug(event: string, data?: Record<string, unknown>) {
    logEvent("debug", event, data)
}

export function logInfo(event: string, data?: Record<string, unknown>) {
    logEvent("info", event, data)
}

export function logWarn(event: string, data?: Record<string, unknown>) {
    logEvent("warn", event, data)
}

export function logError(event: string, error: unknown, data?: Record<string, unknown>) {
    logEvent("error", event, {
        ...data,
        error: serializeError(error),
    })
}

function logEvent(level: LogLevel, event: string, data?: Record<string, unknown>) {
    if (levelOrder[level] < levelOrder[env.LOG_LEVEL])
        return
    if (suppressedEvents.has(event) && level !== "error")
        return

    const normalizedData = data ? normalizeRecord(data, 0) : {}
    const message = messageForEvent(event, normalizedData) ?? fallbackMessage(normalizedData)
    const line = `${formatTimestamp(new Date())} ${paint(level, levelLabel[level])} (${event}): ${message}`

    switch (level) {
        case "debug":
        case "info":
            console.log(line)
            break
        case "warn":
            console.warn(line)
            break
        case "error":
            console.error(line)
            break
    }

    if (level === "error" && normalizedData.error && typeof normalizedData.error === "object") {
        const stack = (normalizedData.error as { stack?: unknown }).stack
        if (typeof stack === "string" && stack.trim()) {
            console.error(`${paint(level, "  ↳")} ${stack}`)
        }
    }
}

function paint(level: LogLevel, text: string) {
    return `${levelColor[level]}${text}${resetColor}`
}

function formatTimestamp(date: Date) {
    const parts = [
        pad(date.getDate()),
        pad(date.getMonth() + 1),
        date.getFullYear(),
    ]
    const time = [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ]
    return `${parts[0]}.${parts[1]}.${parts[2]} ${time[0]}:${time[1]}:${time[2]}`
}

function pad(value: number) {
    return String(value).padStart(2, "0")
}

function messageForEvent(event: string, data: Record<string, unknown>) {
    switch (event) {
        case "process.start":
            return "Process starting"
        case "process.unhandled_rejection":
            return `Unhandled promise rejection — ${errorMessage(data.error)}`
        case "process.uncaught_exception":
            return `Uncaught exception — ${errorMessage(data.error)}`
        case "bot.starting":
            return `Bot starting — DB: ${stringValue(data.dbPath)}, session: ${stringValue(data.sessionPath)}, cobalt: ${stringValue(data.cobaltBaseUrl)}`
        case "bot.started":
            return `Bot started — cobalt: ${stringValue(data.cobaltBaseUrl)}`
        case "runtime.init":
            return "Runtime initialized"
        case "bot.inline_query.received":
            return `Received query - ${stringValue(data.rawQuery) || "<empty>"}`
        case "bot.inline_query.failed":
            return `Inline query failed — ${stringValue(data.rawQuery)} — ${errorMessage(data.error)}`
        case "runtime.inline_request.create":
            return `Creating inline request for ${stringValue(data.rawQuery)}`
        case "runtime.inline_request.created":
            return `Inline request created — ${shortId(stringValue(data.requestId))}, ${stringValue(data.platform)}, ${stringValue(data.normalizedUrl)}`
        case "runtime.metadata.load.start":
            return `Preparing request data for ${stringValue(data.parsedUrl)}`
        case "runtime.rehydrate.cache_hit":
            return `Rehydrate cache hit — ${stringValue(data.platform)}, ${stringValue(data.normalizedUrl)}`
        case "runtime.rehydrate.cached":
            return `Rehydrate data cached — ${stringValue(data.platform)}, ${stringValue(data.normalizedUrl)}`
        case "runtime.rehydrate.normalize_failed":
            return `URL normalization failed for ${stringValue(data.parsedUrl)}`
        case "runtime.metadata.resolved":
            return `Metadata resolved — platform: ${stringValue(data.platform)}, title: ${quoted(data.title)}, comments: ${numberOrDash(data.commentCount)}`
        case "runtime.metadata.resolve_fallback":
            return `Metadata resolve fallback for ${stringValue(data.parsedUrl)}`
        case "runtime.metadata.cache_hit":
            return `Metadata cache hit — ${stringValue(data.platform)}, ${stringValue(data.alias)}`
        case "runtime.metadata.cached":
            return "Metadata cached"
        case "runtime.pretty_metadata.cache_hit":
            return `Pretty metadata cache hit — title: ${quoted(data.title)}, comments: ${numberOrDash(data.commentCount)}`
        case "runtime.pretty_metadata.load.start":
            return `Loading post metadata for ${stringValue(data.normalizedUrl)}`
        case "runtime.pretty_metadata.load.ok":
            return `Post metadata loaded — title: ${quoted(data.title)}, comments: ${numberOrDash(data.commentCount)}`
        case "runtime.pretty_metadata.load.failed":
            return `Post metadata load failed for ${stringValue(data.normalizedUrl)} — ${stringValue(data.reason)}`
        case "metadata.follow_redirect.start":
            return `Resolving short link ${stringValue(data.url)}`
        case "metadata.follow_redirect.ok":
            return `Short link resolved to ${stringValue(data.finalUrl)}`
        case "metadata.follow_redirect.head_failed":
            return `HEAD redirect failed for ${stringValue(data.url)} — ${stringValue(data.reason)}`
        case "metadata.follow_redirect.fallback_fetch_html":
            return `Falling back to full HTML fetch for ${stringValue(data.url)}`
        case "metadata.fetch_html.start":
            return `Fetching HTML from ${stringValue(data.url)}`
        case "metadata.fetch_html.ok":
            return `HTML fetched successfully (${numberOrDash(data.htmlLength)} bytes), status ${numberOrDash(data.status)}`
        case "metadata.fetch_html.http_error":
            return `HTML fetch failed — status ${numberOrDash(data.status)} for ${stringValue(data.url)}`
        case "metadata.fetch_html.failed":
            return `HTML fetch threw for ${stringValue(data.url)} — ${errorMessage(data.error)}`
        case "metadata.tiktok.player_api.start":
            return `Fetching TikTok metadata for ${stringValue(data.mediaId)}`
        case "metadata.tiktok.player_api.ok":
            return `TikTok metadata fetched — itemCount ${numberOrDash(data.itemCount)}, stats ${boolWord(data.hasStats)}`
        case "metadata.tiktok.player_api.http_error":
            return `TikTok metadata HTTP error — status ${numberOrDash(data.status)}`
        case "metadata.tiktok.player_api.failed":
            return `TikTok metadata fetch failed — ${errorMessage(data.error)}`
        case "metadata.x.syndication.request":
            return `Fetching X syndication metadata for tweet ${stringValue(data.tweetId)}`
        case "metadata.x.syndication.response":
            return `X syndication responded with status ${numberOrDash(data.status)}`
        case "metadata.x.syndication.failed":
            return `X syndication failed for tweet ${stringValue(data.tweetId)} — ${stringValue(data.error)}`
        case "metadata.x.html_fallback":
            return `X HTML fallback used for ${stringValue(data.mediaId)}`
        case "runtime.session.hydrate_for_request.start":
            return `Hydrating session for request ${shortId(stringValue(data.requestId))}`
        case "runtime.session.hydrate_for_request.ok":
            return `Session hydrated for ${shortId(stringValue(data.requestId))} — ${numberOrDash(data.itemCount)} item(s), ${size(data.sizeBytes)}, ${audioWord(data.hasAudio)}`
        case "runtime.session.hydrate_from_cache_key.start":
            return `Hydrating session from cache ${shortId(stringValue(data.cacheKey))}`
        case "runtime.session.hydrate_from_cache_key.ok":
            return `Session restored from cache — ${numberOrDash(data.itemCount)} item(s), ${size(data.sizeBytes)}, ${audioWord(data.hasAudio)}`
        case "runtime.session.cache_hit":
            return `Session cache hit — ${numberOrDash(data.itemCount)} item(s), ${size(data.sizeBytes)}`
        case "runtime.session.build.start":
            return `Building session for ${stringValue(data.platform)} — ${stringValue(data.normalizedUrl)}`
        case "runtime.session.build.ok":
            return `Session built successfully — ${numberOrDash(data.itemCount)} item(s), ${size(data.sizeBytes)}, ${audioWord(data.hasAudio)}`
        case "runtime.session.single_downloaded":
            return `File analysed — ${stringValue(path(data, "analysis.kind"))}, ${durationValue(path(data, "analysis.duration"))}, ${dimensionValue(path(data, "analysis.width"), path(data, "analysis.height"))}, ${size(data.sizeBytes)}`
        case "runtime.session.picker_item_downloaded":
            return `Carousel item analysed — #${numberOrDash(data.index)}, ${stringValue(path(data, "analysis.kind"))}, ${dimensionValue(path(data, "analysis.width"), path(data, "analysis.height"))}, ${size(data.sizeBytes)}`
        case "runtime.session.audio_downloaded":
            return `Audio track downloaded — ${stringValue(data.mimeType)}, ${size(data.sizeBytes)}`
        case "cobalt.resolve.request":
            return `Sending resolve request to cobalt — quality: ${stringValue(data.videoQuality)}p, codec: ${stringValue(data.youtubeVideoCodec)}, audio: ${stringValue(data.audioFormat)}/${stringValue(data.audioBitrate)}kbps, proxy: ${boolWord(data.alwaysProxy)}`
        case "cobalt.resolve.response":
            return cobaltResolveMessage(data)
        case "cobalt.resolve.retrying":
            return `Retrying cobalt resolve after ${stringValue(data.errorCode)} (alwaysProxy was ${boolWord(data.attemptedAlwaysProxy)})`
        case "cobalt.fetch_binary.start":
            return `Downloading binary from cobalt tunnel`
        case "cobalt.fetch_binary.ok":
            return `Binary downloaded — ${stringValue(data.mimeType)}, ${numberOrDash(data.sizeBytes)} bytes (${size(data.sizeBytes)})`
        case "cobalt.fetch_binary.http_error":
            return `Binary download failed — status ${numberOrDash(data.status)} for ${stringValue(data.url)}`
        case "bot.chosen_inline.received":
            return `Received chosen result`
        case "bot.chosen_inline.edit_media":
            return `Editing inline message media — ${numberOrDash(data.itemCount)} item(s), ${mediaSummary(data.firstItem)}, ${audioWord(data.hasAudio)}, ${numberOrDash(data.replyMarkupRows)} reply markup row(s)`
        case "bot.chosen_inline.edit_media.ok":
            return `Inline message updated successfully`
        case "bot.chosen_inline.failed":
            return `Chosen inline failed — ${stringValue(data.query)} — ${errorMessage(data.error)}`
        case "bot.chosen_inline.error_message_set":
            return `Fallback error message set — ${stringValue(data.message)}`
        case "bot.callback.carousel":
            return `Carousel click — token ${shortId(stringValue(data.token))}, index ${stringValue(data.index)}`
        case "bot.callback.audio":
            return `Audio mode click — token ${shortId(stringValue(data.token))}, index ${stringValue(data.index)}`
        case "bot.callback.photo":
            return `Photo mode click — token ${shortId(stringValue(data.token))}, index ${stringValue(data.index)}`
        case "bot.callback.caption":
            return `Caption toggle — token ${shortId(stringValue(data.token))}, mode ${stringValue(data.mode)}, index ${numberOrDash(data.index)}, visible ${boolWord(data.captionVisible)}`
        case "bot.callback.retry":
            return `Retry click — token ${shortId(stringValue(data.token))}`
        case "bot.callback.retry.failed":
            return `Retry failed — ${errorMessage(data.error)}`
        case "telegram.dispatcher.rpc_ignored":
            return `Ignoring Telegram RPC error ${stringValue(data.code)}${data.method ? ` on ${stringValue(data.method)}` : ""}`
        case "telegram.dispatcher.unhandled_error":
            return `Unhandled Telegram dispatcher error — ${errorMessage(data.error)}`
        default:
            return undefined
    }
}

function cobaltResolveMessage(data: Record<string, unknown>) {
    const body = objectValue(data.body)
    if (!body)
        return `Cobalt responded with status ${numberOrDash(data.httpStatus)}`
    const status = stringValue(body.status)
    if (status === "error") {
        const error = objectValue(body.error)
        return `Cobalt resolve failed — ${stringValue(error?.code)}`
    }
    if (status === "picker") {
        const picker = Array.isArray(body.picker) ? body.picker.length : 0
        return `Cobalt responded with picker — ${picker} item(s), audio ${boolWord(Boolean(body.audio))}`
    }
    return `Cobalt responded with ${status}, filename: ${stringValue(body.filename)}`
}

function fallbackMessage(data: Record<string, unknown>) {
    const entries = Object.entries(data)
        .filter(([key]) => key !== "error")
        .slice(0, 6)
        .map(([key, value]) => `${key}=${compact(value)}`)
    if (!entries.length && data.error)
        return errorMessage(data.error)
    return entries.join(", ") || "ok"
}

function compact(value: unknown): string {
    if (value === null || value === undefined)
        return "-"
    if (typeof value === "string")
        return value.length > 120 ? `${value.slice(0, 117)}...` : value
    if (typeof value === "number" || typeof value === "boolean")
        return String(value)
    if (Array.isArray(value))
        return `[${value.length}]`
    if (typeof value === "object")
        return "{...}"
    return String(value)
}

function normalizeValue(value: unknown, depth: number): unknown {
    if (value === null || value === undefined)
        return value

    if (value instanceof Error)
        return serializeError(value)

    if (Buffer.isBuffer(value)) {
        return {
            type: "Buffer",
            byteLength: value.byteLength,
        }
    }

    if (value instanceof URL)
        return value.toString()

    if (Array.isArray(value)) {
        if (depth >= 3)
            return `[Array(${value.length})]`
        return value.slice(0, 20).map(item => normalizeValue(item, depth + 1))
    }

    if (typeof value === "object") {
        if (depth >= 4)
            return "[Object]"
        const out: Record<string, unknown> = {}
        for (const [key, entry] of Object.entries(value))
            out[key] = normalizeValue(entry, depth + 1)
        return out
    }

    if (typeof value === "string" && value.length > 1000)
        return `${value.slice(0, 1000)}...<trimmed:${value.length}>`

    return value
}

function normalizeRecord(value: Record<string, unknown>, depth: number) {
    return normalizeValue(value, depth) as Record<string, unknown>
}

function serializeError(error: unknown) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...((error as unknown) as Record<string, unknown>),
        }
    }

    return {
        name: "NonError",
        message: String(error),
    }
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value)
}

function numberOrDash(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "-"
}

function boolWord(value: unknown) {
    return value ? "yes" : "no"
}

function quoted(value: unknown) {
    const text = stringValue(value)
    return text ? `"${text}"` : "\"\""
}

function shortId(value: string) {
    return value.length > 12 ? value.slice(0, 12) : value
}

function size(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return "-"
    if (value < 1024)
        return `${value} B`
    if (value < 1024 * 1024)
        return `${(value / 1024).toFixed(2)} KB`
    if (value < 1024 * 1024 * 1024)
        return `${(value / (1024 * 1024)).toFixed(2)} MB`
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function durationValue(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return "-"
    return `${value.toFixed(3)}s`
}

function dimensionValue(width: unknown, height: unknown) {
    const w = typeof width === "number" ? width : undefined
    const h = typeof height === "number" ? height : undefined
    return w && h ? `${w}×${h}px` : "-"
}

function audioWord(value: unknown) {
    return value ? "with audio" : "no audio"
}

function mediaSummary(value: unknown) {
    const item = objectValue(value)
    if (!item)
        return "unknown item"
    return [
        stringValue(item.kind),
        dimensionValue(item.width, item.height),
        durationValue(item.duration),
        size(item.sizeBytes),
    ].filter(part => part && part !== "-").join(", ")
}

function errorMessage(value: unknown) {
    const error = objectValue(value)
    if (!error)
        return compact(value)
    return stringValue(error.message || error.name || "Unknown error")
}

function objectValue(value: unknown) {
    return value && typeof value === "object" ? value as Record<string, unknown> : null
}

function path(value: unknown, key: string) {
    const root = objectValue(value)
    if (!root)
        return undefined
    return key.split(".").reduce<unknown>((acc, part) => {
        const next = objectValue(acc)
        return next?.[part]
    }, root)
}
