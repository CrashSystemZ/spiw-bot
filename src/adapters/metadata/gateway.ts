import { makeCacheKey } from "../../core/hash.js"
import type { Platform, PreviewKind, ResolvedMetadata } from "../../core/models.js"
import {
    isUrlSupportedByPlatformResolver,
    normalizeMetadataUrl,
    resolveMetadata,
} from "../../core/metadata/index.js"
import type { NormalizedMetadataUrl } from "../../core/types/metadata.js"
import type { ResolvedMetadata as RawResolvedMetadata } from "../../core/types/metadata.js"

export class MetadataGateway {
    isSupportedPlatform(url: string): boolean {
        return isUrlSupportedByPlatformResolver(url)
    }

    async prepareShell(rawInput: string, timeoutMs: number) {
        const normalized = await normalizeMetadataUrl(rawInput, {
            timeoutMs,
        })
        return fromNormalized(normalized)
    }

    async loadDetails(rawInput: string, timeoutMs: number) {
        const resolved = await resolveMetadata(rawInput, {
            timeoutMs,
            allowGenericFallback: true,
        })
        return fromResolved(resolved)
    }

    buildFallback(url: string): ResolvedMetadata {
        const normalizedUrl = new URL(url).toString()
        return fromNormalized({
            platform: "generic",
            originalInput: url,
            extractedUrl: url,
            normalizedUrl,
            sourceUrl: normalizedUrl,
            mediaId: null,
        })
    }
}

function baseFields(source: NormalizedMetadataUrl) {
    return {
        platform: mapPlatform(source.platform),
        cacheKey: makeCacheKey(source.mediaId ?? source.normalizedUrl),
        originalUrl: source.originalInput,
        normalizedUrl: source.normalizedUrl,
        sourceUrl: source.sourceUrl,
        items: [] as ResolvedMetadata["items"],
    }
}

function fromNormalized(source: NormalizedMetadataUrl): ResolvedMetadata {
    return {
        ...baseFields(source),
        title: null,
        description: null,
        thumbnailUrl: null,
        commentCount: null,
        previewUrl: null,
        previewKind: null,
    }
}

function fromResolved(source: RawResolvedMetadata): ResolvedMetadata {
    return {
        ...baseFields(source),
        title: source.title ?? null,
        description: source.caption ?? null,
        thumbnailUrl: source.thumbnailUrl ?? null,
        commentCount: source.commentCount ?? null,
        previewUrl: source.preview?.url ?? null,
        previewKind: mapPreviewKind(source.preview?.kind),
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
