import {randomUUID} from "node:crypto"

import {UnsupportedLinkError} from "../core/errors.js"
import {logInfo, logWarn} from "../core/log.js"
import type {InlineRequestContext, PendingRequestRecord} from "../core/models.js"
import {tryParseUrl} from "../core/url.js"
import {MetadataGateway} from "../adapters/metadata/gateway.js"
import {PostCacheRepository} from "../adapters/persistence/post-cache-repo.js"
import {RequestRepository} from "../adapters/persistence/request-repo.js"
import {DetailsFlow} from "./details-flow.js"

export class RequestFlow {
    constructor(
        private readonly requests: RequestRepository,
        private readonly postCache: PostCacheRepository,
        private readonly metadata: MetadataGateway,
        private readonly details: DetailsFlow,
        private readonly resolveTimeoutMs: number,
        private readonly rehydrateTtlSeconds: number,
    ) {
    }

    async createInlineRequest(rawQuery: string, authorId: number): Promise<InlineRequestContext> {
        logInfo("runtime.inline_request.create", {
            rawQuery,
            authorId,
        })
        const parsedUrl = tryParseUrl(rawQuery)
        if (!parsedUrl)
            throw new UnsupportedLinkError()
        if (!this.metadata.isSupportedPlatform(parsedUrl))
            throw new UnsupportedLinkError()

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

        this.requests.put(request)
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

    async cleanupRequests(beforeTs: number) {
        return this.requests.cleanupExpired(beforeTs)
    }

    async deleteRequest(requestId: string) {
        return this.requests.delete(requestId)
    }

    async #loadMetadata(rawQuery: string, parsedUrl: string) {
        logInfo("runtime.metadata.load.start", {
            rawQuery,
            parsedUrl,
        })
        const cached = this.postCache.findFreshRehydrate(rawQuery, parsedUrl, this.rehydrateTtlSeconds)
        if (cached) {
            const metadata = await this.details.mergePrettyMetadata(cached.metadata)
            logInfo("runtime.rehydrate.cache_hit", {
                alias: cached.alias,
                cacheKey: cached.cacheKey,
                platform: metadata.platform,
                normalizedUrl: metadata.normalizedUrl,
            })
            return metadata
        }

        try {
            const metadata = await this.metadata.prepareShell(parsedUrl, this.resolveTimeoutMs)
            this.postCache.saveRehydrateWithAliases(metadata, rawQuery, parsedUrl, Date.now())
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
            const fallback = this.metadata.buildFallback(parsedUrl)
            this.postCache.saveRehydrateWithAliases(fallback, rawQuery, parsedUrl, Date.now())
            return fallback
        }
    }
}
