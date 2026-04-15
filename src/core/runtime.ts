import {randomUUID} from "node:crypto"

import {env} from "../config/env.js"
import {logDebug, logInfo, logWarn} from "./log.js"
import {analyzeMediaBuffer} from "./media-info.js"
import {CobaltClient, inferMediaKind, mapCobaltError,} from "./cobalt.js"
import {DatabaseClient} from "./db/client.js"
import {buildInlineQueryAliases, makeCacheKey} from "./hash.js"
import type {
    DeliveryStats,
    InlineRequestContext,
    PendingRequestRecord,
    Platform,
    PreviewKind,
    ResolvedMetadata,
    SessionAudioTrack,
    SessionEntry,
    SessionMediaItem,
    UiStateRecord,
} from "./models.js"
import {SessionStore} from "./session-store.js"
import {Semaphore} from "./semaphore.js"
import {tryParseUrl} from "./url.js"
import {createMetadataResolverRegistry, normalizeMetadataUrl, resolveMetadata,} from "./metadata/index.js"
import type {ResolvedMetadata as MetadataResolved} from "./types/metadata.js"

type HydratedRequest = {
    request: PendingRequestRecord
    session: SessionEntry
}

export class SpiwRuntime {
    readonly #db: DatabaseClient
    readonly #cobalt = new CobaltClient()
    readonly #resolverContext = {resolvers: createMetadataResolverRegistry()}
    readonly #sessionStore = new SessionStore(env.MEDIA_BUFFER_BUDGET_BYTES, env.REHYDRATE_TTL_SECONDS * 1000)
    readonly #jobs = new Map<string, Promise<SessionEntry>>()
    readonly #globalSemaphore = new Semaphore(env.MAX_CONCURRENT_JOBS)
    readonly #requestCleanupTimer: NodeJS.Timeout
    #dailyCleanupTimer: NodeJS.Timeout | null = null

    constructor(db: DatabaseClient) {
        this.#db = db
        this.#requestCleanupTimer = setInterval(() => {
            void this.cleanupRequests()
        }, 15 * 60 * 1000)
        this.#requestCleanupTimer.unref()
        this.#scheduleDailyCleanup()
    }

    async init() {
        await this.#db.init()
        logInfo("runtime.init")
    }

    async cleanupRequests() {
        const now = Date.now()
        await this.#db.cleanupRequests(now - (env.REQUEST_TTL_SECONDS * 1000))
        logDebug("runtime.cleanup.requests", {now})
    }

    async cleanupFiveDayData() {
        const now = Date.now()
        const beforeTs = now - (env.REHYDRATE_TTL_SECONDS * 1000)
        this.#sessionStore.cleanup()
        await this.#db.cleanupRehydrate(beforeTs)
        await this.#db.cleanupMetadata(now - (env.METADATA_TTL_SECONDS * 1000))
        await this.#db.cleanupAliases(beforeTs)
        await this.#db.cleanupUiState(now - (env.UI_STATE_TTL_SECONDS * 1000))
        logDebug("runtime.cleanup.five_day", {now, beforeTs})
    }

    async createInlineRequest(rawQuery: string, authorId: number): Promise<InlineRequestContext> {
        logInfo("runtime.inline_request.create", {
            rawQuery,
            authorId,
        })
        const parsedUrl = tryParseUrl(rawQuery)
        if (!parsedUrl)
            throw new Error("Link not supported 😩")

        const metadata = await this.#loadMetadata(rawQuery, parsedUrl)
        const request: PendingRequestRecord = {
            id: `req_${randomUUID()}`,
            authorId,
            rawQuery,
            cacheKey: metadata.cacheKey,
            normalizedUrl: metadata.normalizedUrl,
            sourceUrl: metadata.sourceUrl,
            createdAt: Date.now(),
        }

        await this.#db.putRequest(request)
        logInfo("runtime.inline_request.created", {
            requestId: request.id,
            cacheKey: request.cacheKey,
            platform: metadata.platform,
            normalizedUrl: metadata.normalizedUrl,
            title: metadata.title,
            description: metadata.description,
            commentCount: metadata.commentCount,
        })
        return {
            requestId: request.id,
            metadata,
            request,
        }
    }

    async hydrateSessionForRequest(requestId: string): Promise<HydratedRequest> {
        logInfo("runtime.session.hydrate_for_request.start", {requestId})
        const request = await this.#db.getRequest(requestId)
        if (!request)
            throw new Error("Failed to get media 😵‍💫")
        if (isExpired(request.createdAt, env.REQUEST_TTL_SECONDS))
            throw new Error("Failed to get media 😵‍💫")
        const metadata = await this.#getRehydrateByCacheKey(request.cacheKey)
        if (!metadata)
            throw new Error("Failed to get media 😵‍💫")
        const session = await this.ensureSession(metadata)
        await this.#applyCachedPrettyMetadata(session)
        logInfo("runtime.session.hydrate_for_request.ok", {
            requestId,
            cacheKey: request.cacheKey,
            itemCount: session.items.length,
            hasAudio: Boolean(session.audio),
            sizeBytes: session.sizeBytes,
        })
        return {request, session}
    }

    async hydrateSessionFromCacheKey(cacheKey: string): Promise<SessionEntry> {
        logInfo("runtime.session.hydrate_from_cache_key.start", {cacheKey})
        const metadata = await this.#getRehydrateByCacheKey(cacheKey)
        if (!metadata)
            throw new Error("Failed to get media 😵‍💫")
        const session = await this.ensureSession(metadata)
        await this.#applyCachedPrettyMetadata(session)
        logInfo("runtime.session.hydrate_from_cache_key.ok", {
            cacheKey,
            itemCount: session.items.length,
            hasAudio: Boolean(session.audio),
            sizeBytes: session.sizeBytes,
        })
        return session
    }

    async finishRequest(requestId: string) {
        await this.#db.deleteRequest(requestId)
    }

    async saveUiState(record: Omit<UiStateRecord, "createdAt">) {
        await this.#db.putUiState({
            ...record,
            createdAt: Date.now(),
        })
    }

    async getUiState(token: string) {
        const state = await this.#db.getUiState(token)
        if (!state)
            return null
        if (isExpired(state.createdAt, env.UI_STATE_TTL_SECONDS)) {
            await this.#db.deleteUiState(token)
            return null
        }
        return state
    }

    async deleteUiState(token: string) {
        await this.#db.deleteUiState(token)
    }

    async ensurePrettyMetadata(cacheKey: string): Promise<ResolvedMetadata | null> {
        const cached = await this.#getPrettyMetadataByCacheKey(cacheKey)
        if (cached) {
            logInfo("runtime.pretty_metadata.cache_hit", {
                cacheKey,
                title: cached.title,
                description: cached.description,
                commentCount: cached.commentCount,
            })
            return cached
        }

        const metadata = await this.#getRehydrateByCacheKey(cacheKey)
        if (!metadata)
            return null

        logInfo("runtime.pretty_metadata.load.start", {
            cacheKey,
            platform: metadata.platform,
            normalizedUrl: metadata.normalizedUrl,
        })
        try {
            const resolved = await resolveMetadata(metadata.normalizedUrl, {
                timeoutMs: env.INLINE_RESOLVE_TIMEOUT_MS,
                allowGenericFallback: true,
            }, this.#resolverContext)
            const pretty = this.#mapMetadata(resolved)
            await this.#db.putMetadata({
                cacheKey,
                createdAt: Date.now(),
                value: pretty,
            })
            this.#sessionStore.updateMetadata(cacheKey, pretty)
            logInfo("runtime.pretty_metadata.load.ok", {
                cacheKey,
                platform: pretty.platform,
                title: pretty.title,
                description: pretty.description,
                commentCount: pretty.commentCount,
            })
            return pretty
        } catch (error) {
            logWarn("runtime.pretty_metadata.load.failed", {
                cacheKey,
                platform: metadata.platform,
                normalizedUrl: metadata.normalizedUrl,
                reason: error instanceof Error ? error.message : String(error),
            })
            return null
        }
    }

    async ensureSession(metadata: ResolvedMetadata): Promise<SessionEntry> {
        const cached = this.#sessionStore.get(metadata.cacheKey)
        if (cached) {
            logInfo("runtime.session.cache_hit", {
                cacheKey: metadata.cacheKey,
                itemCount: cached.items.length,
                sizeBytes: cached.sizeBytes,
            })
            return cached
        }

        const active = this.#jobs.get(metadata.cacheKey)
        if (active) {
            logDebug("runtime.session.job_reuse", {
                cacheKey: metadata.cacheKey,
            })
            return active
        }

        const job = this.#globalSemaphore.use(async () => {
            logInfo("runtime.session.build.start", {
                cacheKey: metadata.cacheKey,
                platform: metadata.platform,
                normalizedUrl: metadata.normalizedUrl,
            })
            const session = await this.#buildSession(metadata)
            this.#sessionStore.set(session)
            logInfo("runtime.session.build.ok", {
                cacheKey: metadata.cacheKey,
                itemCount: session.items.length,
                hasAudio: Boolean(session.audio),
                sizeBytes: session.sizeBytes,
            })
            return session
        }).finally(() => {
            this.#jobs.delete(metadata.cacheKey)
        })

        this.#jobs.set(metadata.cacheKey, job)
        return job
    }

    async recordDeliveredItems(session: SessionEntry) {
        const tasks = session.items.flatMap((item) => {
            if (item.kind === "video" || item.kind === "animation")
                return [this.#db.recordDelivery(item.kind, Date.now())]
            return []
        })
        await Promise.all(tasks)
        logInfo("runtime.delivery.recorded", {
            cacheKey: session.cacheKey,
            deliveredKinds: session.items.map(item => item.kind),
        })
    }

    getStats(): Promise<DeliveryStats> {
        return this.#db.getStats(Date.now())
    }

    async #loadMetadata(rawQuery: string, parsedUrl: string) {
        logInfo("runtime.metadata.load.start", {
            rawQuery,
            parsedUrl,
        })
        const aliases = buildInlineQueryAliases(rawQuery, parsedUrl)
        for (const alias of aliases) {
            const cacheKey = await this.#db.getCacheKeyByAlias(alias)
            if (!cacheKey)
                continue
            const cached = await this.#db.getRehydrate(cacheKey)
            if (!cached)
                continue
            if (isExpired(cached.createdAt, env.REHYDRATE_TTL_SECONDS))
                continue
            const metadata = await this.#mergePrettyMetadata(cached.value)
            logInfo("runtime.rehydrate.cache_hit", {
                alias,
                cacheKey,
                platform: metadata.platform,
                normalizedUrl: metadata.normalizedUrl,
            })
            return metadata
        }

        try {
            const normalized = await normalizeMetadataUrl(parsedUrl, {
                timeoutMs: env.INLINE_RESOLVE_TIMEOUT_MS,
            }, this.#resolverContext)
            const metadata = this.#mapNormalizedMetadata(normalized)
            await this.#db.putRehydrate({
                cacheKey: metadata.cacheKey,
                createdAt: Date.now(),
                value: metadata,
            })
            await this.#db.putAliases(metadata.cacheKey, buildInlineQueryAliases(rawQuery, parsedUrl, metadata.normalizedUrl, metadata.sourceUrl))
            logInfo("runtime.rehydrate.cached", {
                platform: metadata.platform,
                cacheKey: metadata.cacheKey,
                normalizedUrl: metadata.normalizedUrl,
                sourceUrl: metadata.sourceUrl,
            })
            return metadata
        } catch {
            logWarn("runtime.rehydrate.normalize_failed", {
                parsedUrl,
            })
            const fallback = this.#buildFallbackMetadata(parsedUrl)
            await this.#db.putRehydrate({
                cacheKey: fallback.cacheKey,
                createdAt: Date.now(),
                value: fallback,
            })
            await this.#db.putAliases(fallback.cacheKey, buildInlineQueryAliases(rawQuery, parsedUrl, fallback.normalizedUrl, fallback.sourceUrl))
            return fallback
        }
    }

    #buildFallbackMetadata(url: string): ResolvedMetadata {
        const normalizedUrl = new URL(url).toString()
        return {
            platform: "generic",
            cacheKey: makeCacheKey(normalizedUrl),
            originalUrl: url,
            normalizedUrl,
            sourceUrl: normalizedUrl,
            title: null,
            description: null,
            thumbnailUrl: null,
            commentCount: null,
            previewUrl: null,
            previewKind: null,
            items: [],
        }
    }

    async #getPrettyMetadataByCacheKey(cacheKey: string) {
        const cached = await this.#db.getMetadata(cacheKey)
        if (!cached)
            return null
        if (isExpired(cached.createdAt, env.METADATA_TTL_SECONDS))
            return null
        return cached.value
    }

    async #getRehydrateByCacheKey(cacheKey: string) {
        const cached = await this.#db.getRehydrate(cacheKey)
        if (!cached)
            return null
        if (isExpired(cached.createdAt, env.REHYDRATE_TTL_SECONDS))
            return null
        return cached.value
    }

    async #mergePrettyMetadata(metadata: ResolvedMetadata) {
        const pretty = await this.#getPrettyMetadataByCacheKey(metadata.cacheKey)
        return pretty ? mergeMetadata(metadata, pretty) : metadata
    }

    async #applyCachedPrettyMetadata(session: SessionEntry) {
        const merged = await this.#mergePrettyMetadata(session.metadata)
        if (merged !== session.metadata) {
            session.metadata = merged
            this.#sessionStore.updateMetadata(session.cacheKey, merged)
        }
    }

    #mapMetadata(resolved: MetadataResolved): ResolvedMetadata {
        return {
            platform: mapPlatform(resolved.platform),
            cacheKey: makeCacheKey(resolved.mediaId ?? resolved.normalizedUrl),
            originalUrl: resolved.originalInput,
            normalizedUrl: resolved.normalizedUrl,
            sourceUrl: resolved.sourceUrl,
            title: resolved.title ?? null,
            description: resolved.caption ?? null,
            thumbnailUrl: resolved.thumbnailUrl ?? null,
            commentCount: resolved.commentCount ?? null,
            previewUrl: resolved.preview?.url ?? null,
            previewKind: mapPreviewKind(resolved.preview?.kind),
            items: [],
        }
    }

    #mapNormalizedMetadata(normalized: import("./types/metadata.js").NormalizedMetadataUrl): ResolvedMetadata {
        return {
            platform: mapPlatform(normalized.platform),
            cacheKey: makeCacheKey(normalized.mediaId ?? normalized.normalizedUrl),
            originalUrl: normalized.originalInput,
            normalizedUrl: normalized.normalizedUrl,
            sourceUrl: normalized.sourceUrl,
            title: null,
            description: null,
            thumbnailUrl: null,
            commentCount: null,
            previewUrl: null,
            previewKind: null,
            items: [],
        }
    }

    async #buildSession(metadata: ResolvedMetadata): Promise<SessionEntry> {
        const response = await this.#cobalt.resolve({
            url: metadata.normalizedUrl,
            downloadMode: "auto",
        })

        logInfo("runtime.session.cobalt_response", {
            cacheKey: metadata.cacheKey,
            status: response.status,
            response,
        })

        if (response.status === "error")
            throw new Error(mapCobaltError(response.error.code))

        if (response.status === "local-processing")
            throw new Error("This media requires local processing and is not supported yet 🫠")

        if (response.status === "picker") {
            const fetchSemaphore = new Semaphore(env.MAX_FETCHES_PER_JOB)
            const items = await Promise.all(response.picker.map((item, index) => fetchSemaphore.use(async () => {
                const fileName = fileNameFromUrl(item.url, `item-${index + 1}`)
                const downloaded = await this.#cobalt.fetchBinary(item.url, fileName, env.MAX_MEDIA_ITEM_BYTES)
                const analysis = await analyzeMediaBuffer(downloaded.buffer)
                logDebug("runtime.session.picker_item_downloaded", {
                    cacheKey: metadata.cacheKey,
                    index,
                    sourceUrl: item.url,
                    fileName: downloaded.fileName,
                    mimeType: downloaded.mimeType,
                    sizeBytes: downloaded.sizeBytes,
                    analysis,
                })
                return {
                    id: `item-${index}`,
                    kind: analysis.kind ?? inferMediaKind(downloaded.fileName, downloaded.mimeType, item.type === "gif" ? "gif" : item.type),
                    fileName: downloaded.fileName,
                    mimeType: downloaded.mimeType,
                    buffer: downloaded.buffer,
                    sizeBytes: downloaded.sizeBytes,
                    width: analysis.width,
                    height: analysis.height,
                    duration: analysis.duration,
                    isAnimated: analysis.isAnimated ?? (item.type === "gif"),
                }
            })))

            let audio: SessionAudioTrack | null = null
            if (response.audio) {
                const audioDownloaded = await this.#cobalt.fetchBinary(
                    response.audio,
                    response.audioFilename ?? fileNameFromUrl(response.audio, "audio-track"),
                    env.MAX_MEDIA_ITEM_BYTES,
                )
                logDebug("runtime.session.audio_downloaded", {
                    cacheKey: metadata.cacheKey,
                    fileName: audioDownloaded.fileName,
                    mimeType: audioDownloaded.mimeType,
                    sizeBytes: audioDownloaded.sizeBytes,
                })
                audio = {
                    fileName: audioDownloaded.fileName,
                    mimeType: audioDownloaded.mimeType,
                    buffer: audioDownloaded.buffer,
                }
            }

            return {
                cacheKey: metadata.cacheKey,
                metadata,
                items: items.map(stripItemSize),
                audio,
                createdAt: Date.now(),
                expiresAt: Date.now() + (3 * 24 * 60 * 60 * 1000),
                sizeBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0) + (audio?.buffer.byteLength ?? 0),
            }
        }

        const downloaded = await this.#cobalt.fetchBinary(response.url, response.filename, env.MAX_MEDIA_ITEM_BYTES)
        const analysis = await analyzeMediaBuffer(downloaded.buffer)
        logDebug("runtime.session.single_downloaded", {
            cacheKey: metadata.cacheKey,
            sourceUrl: response.url,
            fileName: downloaded.fileName,
            mimeType: downloaded.mimeType,
            sizeBytes: downloaded.sizeBytes,
            analysis,
        })
        const item: SessionMediaItem = {
            id: "item-0",
            kind: analysis.kind ?? inferMediaKind(downloaded.fileName, downloaded.mimeType),
            fileName: downloaded.fileName,
            mimeType: downloaded.mimeType,
            buffer: downloaded.buffer,
            width: analysis.width,
            height: analysis.height,
            duration: analysis.duration,
            isAnimated: analysis.isAnimated,
        }

        return {
            cacheKey: metadata.cacheKey,
            metadata,
            items: [item],
            audio: null,
            createdAt: Date.now(),
            expiresAt: Date.now() + (3 * 24 * 60 * 60 * 1000),
            sizeBytes: downloaded.sizeBytes,
        }
    }

    #scheduleDailyCleanup() {
        const delayMs = msUntilNextLocalHour(2)
        this.#dailyCleanupTimer = setTimeout(async () => {
            try {
                await this.cleanupFiveDayData()
            } finally {
                this.#scheduleDailyCleanup()
            }
        }, delayMs)
        this.#dailyCleanupTimer.unref()
    }
}

function mapPlatform(platform: string): Platform {
    switch (platform) {
        case "tiktok":
        case "instagram":
        case "x":
        case "threads":
            return platform
        default:
            return "generic"
    }
}

function mapPreviewKind(kind: string | undefined): PreviewKind | null {
    if (kind === "photo" || kind === "video")
        return kind
    return null
}

function fileNameFromUrl(url: string, fallback: string) {
    const pathname = new URL(url).pathname
    const last = pathname.split("/").filter(Boolean).at(-1)
    return last || fallback
}

function stripItemSize(item: SessionMediaItem & { sizeBytes: number }): SessionMediaItem {
    const {sizeBytes: _sizeBytes, ...rest} = item
    return rest
}

function isExpired(createdAt: number, ttlSeconds: number) {
    return (Date.now() - createdAt) > (ttlSeconds * 1000)
}

function mergeMetadata(base: ResolvedMetadata, pretty: ResolvedMetadata): ResolvedMetadata {
    return {
        ...base,
        title: pretty.title,
        description: pretty.description,
        thumbnailUrl: pretty.thumbnailUrl,
        commentCount: pretty.commentCount,
        previewUrl: pretty.previewUrl,
        previewKind: pretty.previewKind,
    }
}

function msUntilNextLocalHour(targetHour: number) {
    const now = new Date()
    const next = new Date(now)
    next.setHours(targetHour, 0, 0, 0)
    if (next <= now)
        next.setDate(next.getDate() + 1)
    return next.getTime() - now.getTime()
}
