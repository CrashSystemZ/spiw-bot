import {MetadataResolveOptions, NormalizedMetadataUrl, ResolvedMetadata} from "../types/metadata.js";
import {createGenericMetadataResolver, GenericMetadataResolver} from "./resolvers/generic.js";
import {createInstagramMetadataResolver, InstagramMetadataResolver} from "./resolvers/instagram.js";
import {createThreadsMetadataResolver, ThreadsMetadataResolver} from "./resolvers/threads.js";
import {createTikTokMetadataResolver, TikTokMetadataResolver} from "./resolvers/tiktok.js";
import {createXMetadataResolver, XMetadataResolver} from "./resolvers/x.js";
import {MetadataResolver} from "./resolvers/base.js";
import {MetadataUnavailableError} from "./errors.js";
import {extractUrlFromText} from "./url.js";

export interface MetadataResolverRegistry {
    readonly tiktok: TikTokMetadataResolver;
    readonly instagram: InstagramMetadataResolver;
    readonly x: XMetadataResolver;
    readonly threads: ThreadsMetadataResolver;
    readonly generic: GenericMetadataResolver;
}

export interface MetadataResolutionContext {
    readonly resolvers: MetadataResolverRegistry;
}

export function createMetadataResolverRegistry(): MetadataResolverRegistry {
    return {
        tiktok: createTikTokMetadataResolver(),
        instagram: createInstagramMetadataResolver(),
        x: createXMetadataResolver(),
        threads: createThreadsMetadataResolver(),
        generic: createGenericMetadataResolver(),
    };
}

function pickResolver(registry: MetadataResolverRegistry, url: URL): MetadataResolver {
    if (registry.tiktok.canHandle(url)) {
        return registry.tiktok;
    }
    if (registry.instagram.canHandle(url)) {
        return registry.instagram;
    }
    if (registry.x.canHandle(url)) {
        return registry.x;
    }
    if (registry.threads.canHandle(url)) {
        return registry.threads;
    }
    return registry.generic;
}

export async function normalizeMetadataUrl(rawInput: string, options: MetadataResolveOptions = {}, context: MetadataResolutionContext = {resolvers: createMetadataResolverRegistry()}): Promise<NormalizedMetadataUrl> {
    const url = new URL(extractUrlFromText(rawInput));
    const resolver = pickResolver(context.resolvers, url);
    return resolver.normalize(rawInput, options);
}

export async function resolveMetadata(rawInput: string, options: MetadataResolveOptions = {}, context: MetadataResolutionContext = {resolvers: createMetadataResolverRegistry()}): Promise<ResolvedMetadata> {
    const normalized = await normalizeMetadataUrl(rawInput, options, context);
    const url = new URL(normalized.normalizedUrl);
    const resolver = pickResolver(context.resolvers, url);

    try {
        return await resolver.resolve(normalized, options);
    } catch (error) {
        if (!options.allowGenericFallback || resolver.platform === "generic") {
            throw error instanceof MetadataUnavailableError ? error : new MetadataUnavailableError("Failed to resolve metadata");
        }
        return context.resolvers.generic.resolve(normalized, options);
    }
}

export type {
    MetadataResolveOptions,
    NormalizedMetadataUrl,
    ResolvedMetadata,
} from "../types/metadata.js";
