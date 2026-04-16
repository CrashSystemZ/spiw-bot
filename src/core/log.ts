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
    "cobalt.resolve.request",
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

type D = Record<string, unknown>

const eventMessages: Record<string, (d: D) => string> = {
    "process.start": () => "Process starting",
    "process.unhandled_rejection": (d) => `Unhandled promise rejection — ${errorMessage(d.error)}`,
    "process.uncaught_exception": (d) => `Uncaught exception — ${errorMessage(d.error)}`,
    "bot.starting": (d) => `Bot starting — DB: ${stringValue(d.dbPath)}, session: ${stringValue(d.sessionPath)}, cobalt: ${stringValue(d.cobaltBaseUrl)}`,
    "bot.started": (d) => `Bot started — cobalt: ${stringValue(d.cobaltBaseUrl)}`,
    "runtime.init": () => "Runtime initialized",
    "bot.inline_query.received": (d) => `Received query - ${stringValue(d.rawQuery) || "<empty>"}`,
    "bot.inline_query.failed": (d) => `Inline query failed — ${stringValue(d.rawQuery)} — ${errorMessage(d.error)}`,
    "runtime.inline_request.create": (d) => `Creating inline request for ${stringValue(d.rawQuery)}`,
    "runtime.inline_request.created": (d) => `Inline request created — ${shortId(stringValue(d.requestId))}, ${stringValue(d.platform)}, ${stringValue(d.normalizedUrl)}`,
    "runtime.metadata.load.start": (d) => `Preparing request data for ${stringValue(d.parsedUrl)}`,
    "runtime.rehydrate.cache_hit": (d) => `Rehydrate cache hit — ${stringValue(d.platform)}, ${stringValue(d.normalizedUrl)}`,
    "runtime.rehydrate.cached": (d) => `Rehydrate data cached — ${stringValue(d.platform)}, ${stringValue(d.normalizedUrl)}`,
    "runtime.rehydrate.normalize_failed": (d) => `URL normalization failed for ${stringValue(d.parsedUrl)}`,
    "runtime.metadata.resolved": (d) => `Metadata resolved — platform: ${stringValue(d.platform)}, title: ${quoted(d.title)}, comments: ${numberOrDash(d.commentCount)}`,
    "runtime.metadata.resolve_fallback": (d) => `Metadata resolve fallback for ${stringValue(d.parsedUrl)}`,
    "runtime.metadata.cache_hit": (d) => `Metadata cache hit — ${stringValue(d.platform)}, ${stringValue(d.alias)}`,
    "runtime.metadata.cached": () => "Metadata cached",
    "runtime.pretty_metadata.cache_hit": (d) => `Pretty metadata cache hit — title: ${quoted(d.title)}, comments: ${numberOrDash(d.commentCount)}`,
    "runtime.pretty_metadata.load.start": (d) => `Loading post metadata for ${stringValue(d.normalizedUrl)}`,
    "runtime.pretty_metadata.load.ok": (d) => `Post metadata loaded — title: ${quoted(d.title)}, comments: ${numberOrDash(d.commentCount)}`,
    "runtime.pretty_metadata.load.failed": (d) => `Post metadata load failed for ${stringValue(d.normalizedUrl)} — ${stringValue(d.reason)}`,
    "metadata.follow_redirect.start": (d) => `Resolving short link ${stringValue(d.url)}`,
    "metadata.follow_redirect.ok": (d) => `Short link resolved to ${stringValue(d.finalUrl)}`,
    "metadata.follow_redirect.head_failed": (d) => `HEAD redirect failed for ${stringValue(d.url)} — ${stringValue(d.reason)}`,
    "metadata.follow_redirect.fallback_fetch_html": (d) => `Falling back to full HTML fetch for ${stringValue(d.url)}`,
    "metadata.fetch_html.start": (d) => `Fetching HTML from ${stringValue(d.url)}`,
    "metadata.fetch_html.ok": (d) => `HTML fetched successfully (${numberOrDash(d.htmlLength)} bytes), status ${numberOrDash(d.status)}`,
    "metadata.fetch_html.http_error": (d) => `HTML fetch failed — status ${numberOrDash(d.status)} for ${stringValue(d.url)}`,
    "metadata.fetch_html.failed": (d) => `HTML fetch threw for ${stringValue(d.url)} — ${errorMessage(d.error)}`,
    "metadata.tiktok.player_api.start": (d) => `Fetching TikTok metadata for ${stringValue(d.mediaId)}`,
    "metadata.tiktok.player_api.ok": (d) => `TikTok metadata fetched — itemCount ${numberOrDash(d.itemCount)}, stats ${boolWord(d.hasStats)}`,
    "metadata.tiktok.player_api.http_error": (d) => `TikTok metadata HTTP error — status ${numberOrDash(d.status)}`,
    "metadata.tiktok.player_api.failed": (d) => `TikTok metadata fetch failed — ${errorMessage(d.error)}`,
    "metadata.x.syndication.request": (d) => `Fetching X syndication metadata for tweet ${stringValue(d.tweetId)}`,
    "metadata.x.syndication.response": (d) => `X syndication responded with status ${numberOrDash(d.status)}`,
    "metadata.x.syndication.failed": (d) => `X syndication failed for tweet ${stringValue(d.tweetId)} — ${stringValue(d.error)}`,
    "metadata.x.html_fallback": (d) => `X HTML fallback used for ${stringValue(d.mediaId)}`,
    "runtime.session.hydrate_for_request.start": (d) => `Hydrating session for request ${shortId(stringValue(d.requestId))}`,
    "runtime.session.hydrate_for_request.ok": (d) => `Session hydrated for ${shortId(stringValue(d.requestId))} — ${numberOrDash(d.itemCount)} item(s), ${size(d.sizeBytes)}, ${audioWord(d.hasAudio)}`,
    "runtime.session.hydrate_from_cache_key.start": (d) => `Hydrating session from cache ${shortId(stringValue(d.cacheKey))}`,
    "runtime.session.hydrate_from_cache_key.ok": (d) => `Session restored from cache — ${numberOrDash(d.itemCount)} item(s), ${size(d.sizeBytes)}, ${audioWord(d.hasAudio)}`,
    "runtime.session.cache_hit": (d) => `Session cache hit — ${numberOrDash(d.itemCount)} item(s), ${size(d.sizeBytes)}`,
    "runtime.session.build.start": (d) => `Building session for ${stringValue(d.platform)} — ${stringValue(d.normalizedUrl)}`,
    "runtime.session.build.ok": (d) => `Session built successfully — ${numberOrDash(d.itemCount)} item(s), ${size(d.sizeBytes)}, ${audioWord(d.hasAudio)}`,
    "runtime.session.single_downloaded": (d) => `File analysed — ${stringValue(path(d, "analysis.kind"))}, ${durationValue(path(d, "analysis.duration"))}, ${dimensionValue(path(d, "analysis.width"), path(d, "analysis.height"))}, ${size(d.sizeBytes)}`,
    "runtime.session.picker_item_downloaded": (d) => `Carousel item analysed — #${numberOrDash(d.index)}, ${stringValue(path(d, "analysis.kind"))}, ${dimensionValue(path(d, "analysis.width"), path(d, "analysis.height"))}, ${size(d.sizeBytes)}`,
    "runtime.session.audio_downloaded": (d) => `Audio track downloaded — ${stringValue(d.mimeType)}, ${size(d.sizeBytes)}`,
    "cobalt.resolve.request": (d) => `Cobalt request → ${stringValue(d.endpoint)} (quality ${stringValue(d.videoQuality)}p, proxy ${boolWord(d.alwaysProxy)})`,
    "cobalt.resolve.response": cobaltResolveMessage,
    "cobalt.resolve.retrying": (d) => `Retrying cobalt ${stringValue(d.endpoint)} after ${stringValue(d.errorCode)} — attempt ${numberOrDash(d.attempt)}, next delay ${numberOrDash(d.nextDelayMs)}ms`,
    "cobalt.resolve.network_error": (d) => `Cobalt network error on ${stringValue(d.endpoint)} — ${stringValue(d.error)}`,
    "cobalt.resolve.bad_body": (d) => `Cobalt returned unparseable body from ${stringValue(d.endpoint)} (HTTP ${numberOrDash(d.httpStatus)})`,
    "cobalt.pool.started": (d) => `Cobalt pool started — ${numberOrDash(d.staticCount)} static endpoint(s), discovery ${boolWord(d.discoveryEnabled)}`,
    "cobalt.pool.refreshed": (d) => `Cobalt pool refreshed — ${numberOrDash(d.staticCount)} static + ${numberOrDash(d.dynamicCount)} dynamic endpoint(s)`,
    "cobalt.pool.refresh_http_error": (d) => `Cobalt pool refresh HTTP error — status ${numberOrDash(d.status)}`,
    "cobalt.pool.refresh_invalid_body": () => `Cobalt pool refresh returned invalid body`,
    "cobalt.pool.refresh_failed": (d) => `Cobalt pool refresh failed — ${stringValue(d.error)}`,
    "cobalt.pool.endpoint_failed": (d) => `Cobalt endpoint ${stringValue(d.endpoint)} failed — ${stringValue(d.errorCode)}, falling through (${numberOrDash(d.remainingEndpoints)} left)`,
    "cobalt.fetch_binary.start": () => `Downloading binary from cobalt tunnel`,
    "cobalt.fetch_binary.ok": (d) => `Binary downloaded — ${stringValue(d.mimeType)}, ${numberOrDash(d.sizeBytes)} bytes (${size(d.sizeBytes)})`,
    "cobalt.fetch_binary.http_error": (d) => `Binary download failed — status ${numberOrDash(d.status)} for ${stringValue(d.url)}`,
    "cobalt.fetch_binary.empty": (d) => `Cobalt tunnel returned empty body (HTTP ${numberOrDash(d.httpStatus)}, mime ${stringValue(d.mimeType)})`,
    "cobalt.fetch_binary.empty_retry": (d) => `Retrying empty binary download — attempt ${numberOrDash(d.attempt)}`,
    "cobalt.pool.endpoint_banned": (d) => `Cobalt endpoint banned until next pool refresh: ${stringValue(d.host)} (${stringValue(d.reason)})`,
    "bot.chosen_inline.received": () => `Received chosen result`,
    "bot.chosen_inline.edit_media": (d) => `Editing inline message media — ${numberOrDash(d.itemCount)} item(s), ${mediaSummary(d.firstItem)}, ${audioWord(d.hasAudio)}, ${numberOrDash(d.replyMarkupRows)} reply markup row(s)`,
    "bot.chosen_inline.edit_media.ok": () => `Inline message updated successfully`,
    "bot.chosen_inline.failed": (d) => `Chosen inline failed — ${stringValue(d.query)} — ${errorMessage(d.error)}`,
    "bot.chosen_inline.error_message_set": (d) => `Fallback error message set — ${stringValue(d.message)}`,
    "bot.callback.carousel": (d) => `Carousel click — token ${shortId(stringValue(d.token))}, index ${stringValue(d.index)}`,
    "bot.callback.audio": (d) => `Audio mode click — token ${shortId(stringValue(d.token))}, index ${stringValue(d.index)}`,
    "bot.callback.photo": (d) => `Photo mode click — token ${shortId(stringValue(d.token))}, index ${stringValue(d.index)}`,
    "bot.callback.caption": (d) => `Caption toggle — token ${shortId(stringValue(d.token))}, mode ${stringValue(d.mode)}, index ${numberOrDash(d.index)}, visible ${boolWord(d.captionVisible)}`,
    "bot.callback.retry": (d) => `Retry click — token ${shortId(stringValue(d.token))}`,
    "bot.callback.retry.failed": (d) => `Retry failed — ${errorMessage(d.error)}`,
    "telegram.dispatcher.rpc_ignored": (d) => `Ignoring Telegram RPC error ${stringValue(d.code)}${d.method ? ` on ${stringValue(d.method)}` : ""}`,
    "telegram.dispatcher.unhandled_error": (d) => `Unhandled Telegram dispatcher error — ${errorMessage(d.error)}`,
}

function messageForEvent(event: string, data: Record<string, unknown>) {
    return eventMessages[event]?.(data)
}

function cobaltResolveMessage(data: Record<string, unknown>) {
    const status = stringValue(data.status)
    if (!status)
        return `Cobalt responded with HTTP ${numberOrDash(data.httpStatus)}`
    return `Cobalt responded with ${status} (HTTP ${numberOrDash(data.httpStatus)})`
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
