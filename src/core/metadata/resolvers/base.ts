import {MetadataResolveOptions, NormalizedMetadataUrl, ResolvedMetadata} from "../../types/metadata.js";

export interface MetadataResolver {
    readonly platform: string;

    canHandle(url: URL): boolean;

    normalize(rawInput: string, options?: MetadataResolveOptions): Promise<NormalizedMetadataUrl>;

    resolve(normalized: NormalizedMetadataUrl, options?: MetadataResolveOptions): Promise<ResolvedMetadata>;
}
