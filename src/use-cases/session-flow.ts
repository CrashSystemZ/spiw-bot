import {type LimitFunction} from "p-limit"

import type {PendingRequestRecord, ResolvedMetadata, SessionEntry} from "../core/models.js"
import {isExpired} from "../core/time.js"
import {logDebug, logInfo} from "../core/log.js"
import {SessionStore} from "../core/session-store.js"
import {RequestRepository} from "../adapters/persistence/request-repo.js"
import {PostCacheRepository} from "../adapters/persistence/post-cache-repo.js"
import {StatsRepository} from "../adapters/persistence/stats-repo.js"
import {MediaSessionBuilder} from "../adapters/media/session-builder.js"
import {DetailsFlow} from "./details-flow.js"

export type HydratedRequest = {
    request: PendingRequestRecord
    session: SessionEntry
}

export class SessionFlow {
    readonly #jobs = new Map<string, Promise<SessionEntry>>()

    constructor(
        private readonly requests: RequestRepository,
        private readonly postCache: PostCacheRepository,
        private readonly details: DetailsFlow,
        private readonly stats: StatsRepository,
        private readonly sessionStore: SessionStore,
        private readonly sessionBuilder: MediaSessionBuilder,
        private readonly limit: LimitFunction,
        private readonly requestTtlSeconds: number,
        private readonly rehydrateTtlSeconds: number,
    ) {
    }

    async hydrateSessionForRequest(requestId: string): Promise<HydratedRequest> {
        logInfo("runtime.session.hydrate_for_request.start", {requestId})
        const request = this.requests.get(requestId)
        if (!request)
            throw new Error("Failed to get media 😵‍💫")
        if (isExpired(request.createdAt, this.requestTtlSeconds))
            throw new Error("Failed to get media 😵‍💫")

        const metadata = await this.#getRehydrateByCacheKey(request.cacheKey)
        if (!metadata)
            throw new Error("Failed to get media 😵‍💫")

        const session = await this.ensureSession(metadata)
        await this.details.applyPrettyMetadata(session)
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
        await this.details.applyPrettyMetadata(session)
        logInfo("runtime.session.hydrate_from_cache_key.ok", {
            cacheKey,
            itemCount: session.items.length,
            hasAudio: Boolean(session.audio),
            sizeBytes: session.sizeBytes,
        })
        return session
    }

    async ensureSession(metadata: ResolvedMetadata): Promise<SessionEntry> {
        const cached = this.sessionStore.get(metadata.cacheKey)
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

        const job = this.limit(async () => {
            logInfo("runtime.session.build.start", {
                cacheKey: metadata.cacheKey,
                platform: metadata.platform,
                normalizedUrl: metadata.normalizedUrl,
            })
            const session = await this.sessionBuilder.build(metadata)
            this.sessionStore.set(session)
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
                return [this.stats.recordDelivery(item.kind, Date.now())]
            return []
        })
        await Promise.all(tasks)
        logInfo("runtime.delivery.recorded", {
            cacheKey: session.cacheKey,
            deliveredKinds: session.items.map(item => item.kind),
        })
    }

    async cleanupFiveDayData(beforeTs: number) {
        this.sessionStore.cleanup()
        this.postCache.cleanupRehydrate(beforeTs)
        this.postCache.cleanupPretty(beforeTs)
        this.postCache.cleanupAliases(beforeTs)
    }

    async #getRehydrateByCacheKey(cacheKey: string) {
        const cached = this.postCache.getFreshRehydrate(cacheKey, this.rehydrateTtlSeconds)
        return cached ?? null
    }
}
