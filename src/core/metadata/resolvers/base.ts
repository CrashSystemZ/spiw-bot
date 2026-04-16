import type { MetadataPlatform, MetadataResolveOptions, NormalizedMetadataUrl, ResolvedMetadata } from "../../types/metadata.js"

export interface MetadataResolver {
    readonly platform: MetadataPlatform

    canHandle(url: URL): boolean

    normalize(rawInput: string, options?: MetadataResolveOptions): Promise<NormalizedMetadataUrl>

    resolve(normalized: NormalizedMetadataUrl, options?: MetadataResolveOptions): Promise<ResolvedMetadata>
}
