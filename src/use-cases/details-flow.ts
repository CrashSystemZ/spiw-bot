import {logInfo, logWarn} from "../core/log.js"
import type {ResolvedMetadata, SessionEntry} from "../core/models.js"
import {SessionStore} from "../core/session-store.js"
import {MetadataGateway} from "../adapters/metadata/gateway.js"
import {PostCacheRepository} from "../adapters/persistence/post-cache-repo.js"

export class DetailsFlow {
    constructor(
        private readonly postCache: PostCacheRepository,
        private readonly metadata: MetadataGateway,
        private readonly sessionStore: SessionStore,
        private readonly rehydrateTtlSeconds: number,
        private readonly resolveTimeoutMs: number,
        private readonly metadataTtlSeconds: number,
    ) {
    }

    async mergePrettyMetadata(base: ResolvedMetadata): Promise<ResolvedMetadata> {
        const pretty = this.postCache.getFreshPretty(base.cacheKey, this.metadataTtlSeconds)
        return pretty ? mergeMetadata(base, pretty) : base
    }

    async applyPrettyMetadata(session: SessionEntry) {
        const merged = await this.mergePrettyMetadata(session.metadata)
        if (merged !== session.metadata) {
            session.metadata = merged
            this.sessionStore.updateMetadata(session.cacheKey, merged)
        }
        return session
    }

    async ensurePrettyMetadata(cacheKey: string): Promise<ResolvedMetadata | null> {
        const cached = this.postCache.getFreshPretty(cacheKey, this.metadataTtlSeconds)
        if (cached) {
            logInfo("runtime.pretty_metadata.cache_hit", {
                cacheKey,
                title: cached.title,
                description: cached.description,
                commentCount: cached.commentCount,
            })
            return cached
        }

        const metadata = this.postCache.getFreshRehydrate(cacheKey, this.rehydrateTtlSeconds)
        if (!metadata)
            return null

        logInfo("runtime.pretty_metadata.load.start", {
            cacheKey,
            platform: metadata.platform,
            normalizedUrl: metadata.normalizedUrl,
        })
        try {
            const pretty = await this.metadata.loadDetails(metadata.normalizedUrl, this.resolveTimeoutMs)
            this.postCache.putPretty({
                cacheKey,
                createdAt: Date.now(),
                value: pretty,
            })
            this.sessionStore.updateMetadata(cacheKey, pretty)
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
