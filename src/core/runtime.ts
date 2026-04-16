import pLimit from "p-limit"

import {env} from "../config/env.js"
import {CobaltClient} from "./cobalt.js"
import {type CobaltEndpoint, CobaltPool} from "./cobalt-pool.js"
import {logDebug, logInfo} from "./log.js"
import {DatabaseClient} from "./db/client.js"
import type {DeliveryStats, InlineRequestContext, ResolvedMetadata, SessionEntry, UiStateRecord} from "./models.js"
import {SessionStore} from "./session-store.js"
import {MetadataGateway} from "../adapters/metadata/gateway.js"
import {MediaSessionBuilder} from "../adapters/media/session-builder.js"
import {PostCacheRepository} from "../adapters/persistence/post-cache-repo.js"
import {RequestRepository} from "../adapters/persistence/request-repo.js"
import {StatsRepository} from "../adapters/persistence/stats-repo.js"
import {UiStateRepository} from "../adapters/persistence/ui-state-repo.js"
import {DetailsFlow} from "../use-cases/details-flow.js"
import {RequestFlow} from "../use-cases/request-flow.js"
import {type HydratedRequest, SessionFlow} from "../use-cases/session-flow.js"

export class SpiwRuntime {
    readonly #db: DatabaseClient
    readonly #uiState: UiStateRepository
    readonly #stats: StatsRepository
    readonly #details: DetailsFlow
    readonly #requestFlow: RequestFlow
    readonly #sessionFlow: SessionFlow
    readonly #cobaltPool: CobaltPool
    #requestCleanupTimer: NodeJS.Timeout | null = null
    #dailyCleanupTimer: NodeJS.Timeout | null = null

    constructor(db: DatabaseClient) {
        this.#db = db
        const requests = new RequestRepository(db)
        const postCache = new PostCacheRepository(db)
        const sessionStore = new SessionStore(env.MEDIA_BUFFER_BUDGET_BYTES, env.REHYDRATE_TTL_SECONDS * 1000)
        const metadataGateway = new MetadataGateway()
        this.#cobaltPool = buildCobaltPool()
        const cobaltClient = new CobaltClient(this.#cobaltPool)
        this.#uiState = new UiStateRepository(db)
        this.#stats = new StatsRepository(db)
        this.#details = new DetailsFlow(
            postCache,
            metadataGateway,
            sessionStore,
            env.REHYDRATE_TTL_SECONDS,
            env.INLINE_RESOLVE_TIMEOUT_MS,
            env.METADATA_TTL_SECONDS,
        )
        this.#requestFlow = new RequestFlow(
            requests,
            postCache,
            metadataGateway,
            this.#details,
            env.INLINE_RESOLVE_TIMEOUT_MS,
            env.REHYDRATE_TTL_SECONDS,
        )
        this.#sessionFlow = new SessionFlow(
            requests,
            postCache,
            this.#details,
            this.#stats,
            sessionStore,
            new MediaSessionBuilder(cobaltClient, env.REHYDRATE_TTL_SECONDS * 1000),
            pLimit(env.MAX_CONCURRENT_JOBS),
            env.REQUEST_TTL_SECONDS,
            env.REHYDRATE_TTL_SECONDS,
        )
    }

    start() {
        void this.#cobaltPool.start()
        this.#requestCleanupTimer = setInterval(() => {
            void this.cleanupRequests()
        }, 15 * 60 * 1000)
        this.#requestCleanupTimer.unref()
        this.#scheduleDailyCleanup()
        logInfo("runtime.init")
    }

    async dispose() {
        this.#cobaltPool.dispose()
        if (this.#requestCleanupTimer) {
            clearInterval(this.#requestCleanupTimer)
            this.#requestCleanupTimer = null
        }
        if (this.#dailyCleanupTimer) {
            clearTimeout(this.#dailyCleanupTimer)
            this.#dailyCleanupTimer = null
        }
        await this.#db.close()
    }

    async cleanupRequests() {
        const now = Date.now()
        await this.#requestFlow.cleanupRequests(now - (env.REQUEST_TTL_SECONDS * 1000))
        logDebug("runtime.cleanup.requests", {now})
    }

    async cleanupFiveDayData() {
        const now = Date.now()
        const beforeTs = now - (env.REHYDRATE_TTL_SECONDS * 1000)
        await this.#sessionFlow.cleanupFiveDayData(beforeTs)
        this.#uiState.cleanupExpired(now - (env.UI_STATE_TTL_SECONDS * 1000))
        logDebug("runtime.cleanup.five_day", {now, beforeTs})
    }

    async createInlineRequest(rawQuery: string, authorId: number): Promise<InlineRequestContext> {
        return this.#requestFlow.createInlineRequest(rawQuery, authorId)
    }

    async hydrateSessionForRequest(requestId: string): Promise<HydratedRequest> {
        return this.#sessionFlow.hydrateSessionForRequest(requestId)
    }

    async hydrateSessionFromCacheKey(cacheKey: string): Promise<SessionEntry> {
        return this.#sessionFlow.hydrateSessionFromCacheKey(cacheKey)
    }

    async finishRequest(requestId: string) {
        await this.#requestFlow.deleteRequest(requestId)
    }

    async saveUiState(record: Omit<UiStateRecord, "createdAt">) {
        this.#uiState.put({
            ...record,
            createdAt: Date.now(),
        })
    }

    async getUiState(token: string) {
        return this.#uiState.getFresh(token, env.UI_STATE_TTL_SECONDS)
    }

    async deleteUiState(token: string) {
        this.#uiState.delete(token)
    }

    async ensurePrettyMetadata(cacheKey: string): Promise<ResolvedMetadata | null> {
        return this.#details.ensurePrettyMetadata(cacheKey)
    }

    async recordDeliveredItems(session: SessionEntry) {
        await this.#sessionFlow.recordDeliveredItems(session)
    }

    getStats(): DeliveryStats {
        return this.#stats.getStats(Date.now())
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

function msUntilNextLocalHour(targetHour: number) {
    const now = new Date()
    const next = new Date(now)
    next.setHours(targetHour, 0, 0, 0)
    if (next <= now)
        next.setDate(next.getDate() + 1)
    return next.getTime() - now.getTime()
}

function buildCobaltPool(): CobaltPool {
    const staticEndpoints: CobaltEndpoint[] = [
        {
            name: "primary",
            url: env.COBALT_BASE_URL,
            ...(env.COBALT_AUTHORIZATION ? {authorization: env.COBALT_AUTHORIZATION} : {}),
        },
        ...env.COBALT_EXTRA_ENDPOINTS.map(url => ({name: hostFromUrl(url), url})),
    ]
    const discovery = env.COBALT_DISCOVERY_ENABLED
        ? {
            url: env.COBALT_DISCOVERY_URL,
            services: env.COBALT_DISCOVERY_SERVICES,
            max: env.COBALT_DISCOVERY_MAX,
            refreshMs: env.COBALT_DISCOVERY_REFRESH_MS,
            requestTimeoutMs: env.COBALT_REQUEST_TIMEOUT_MS,
        }
        : null
    return new CobaltPool(staticEndpoints, discovery)
}

function hostFromUrl(rawUrl: string): string {
    try {
        return new URL(rawUrl).host
    } catch {
        return rawUrl
    }
}
