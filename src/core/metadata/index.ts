import type { MetadataResolveOptions, NormalizedMetadataUrl, ResolvedMetadata } from "../types/metadata.js"
import { createGenericMetadataResolver } from "./resolvers/generic.js"
import { createInstagramMetadataResolver } from "./resolvers/instagram.js"
import { createThreadsMetadataResolver } from "./resolvers/threads.js"
import { createTikTokMetadataResolver } from "./resolvers/tiktok.js"
import { createXMetadataResolver } from "./resolvers/x.js"
import type { MetadataResolver } from "./resolvers/base.js"
import { MetadataUnavailableError } from "./errors.js"
import { extractUrlFromText } from "./url.js"

export type MetadataResolvers = readonly MetadataResolver[]

export interface MetadataResolutionContext {
    readonly resolvers: MetadataResolvers
}

const defaultResolvers = createMetadataResolvers()
const defaultResolutionContext: MetadataResolutionContext = {
    resolvers: defaultResolvers,
}

export function createMetadataResolvers(): MetadataResolvers {
    return [
        createTikTokMetadataResolver(),
        createInstagramMetadataResolver(),
        createXMetadataResolver(),
        createThreadsMetadataResolver(),
        createGenericMetadataResolver(),
    ]
}

export async function normalizeMetadataUrl(
    rawInput: string,
    options: MetadataResolveOptions = {},
    context: MetadataResolutionContext = defaultResolutionContext,
): Promise<NormalizedMetadataUrl> {
    const url = new URL(extractUrlFromText(rawInput))
    const resolver = pickResolver(context.resolvers, url)
    return resolver.normalize(rawInput, options)
}

export async function resolveMetadata(
    rawInput: string,
    options: MetadataResolveOptions = {},
    context: MetadataResolutionContext = defaultResolutionContext,
): Promise<ResolvedMetadata> {
    const normalized = await normalizeMetadataUrl(rawInput, options, context)
    const resolver = pickResolver(context.resolvers, new URL(normalized.normalizedUrl))
    const fallback = context.resolvers[context.resolvers.length - 1]

    try {
        return await resolver.resolve(normalized, options)
    } catch (error) {
        if (!options.allowGenericFallback || resolver.platform === "generic" || !fallback) {
            throw error instanceof MetadataUnavailableError ? error : new MetadataUnavailableError("Failed to resolve metadata")
        }
        return fallback.resolve(normalized, options)
    }
}

function pickResolver(resolvers: MetadataResolvers, url: URL): MetadataResolver {
    return resolvers.find((resolver) => resolver.canHandle(url)) ?? resolvers[resolvers.length - 1]!
}

export type { MetadataResolveOptions, NormalizedMetadataUrl, ResolvedMetadata } from "../types/metadata.js"
