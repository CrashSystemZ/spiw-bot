export type MetadataPlatform = "tiktok" | "instagram" | "x" | "threads" | "generic";

export type MetadataMediaKind = "video" | "photo" | "carousel" | "text" | "unknown";

export type MetadataPreviewKind = "photo" | "video";

export interface MetadataPreview {
    kind: MetadataPreviewKind;
    url: string;
    width?: number;
    height?: number;
}

export interface MetadataHints {
    simplePhotoPreview?: boolean;
    slideshowAudioAvailable?: boolean;
    isCarousel?: boolean;
    isVideo?: boolean;
    isPhoto?: boolean;
    isTextOnly?: boolean;
}

export interface NormalizedMetadataUrl {
    originalInput: string;
    extractedUrl: string;
    normalizedUrl: string;
    sourceUrl: string;
    platform: MetadataPlatform;
    mediaId: string | null;
    cacheKeySeed: string;
}

export interface ResolvedMetadata {
    originalInput: string;
    extractedUrl: string;
    normalizedUrl: string;
    sourceUrl: string;
    platform: MetadataPlatform;
    mediaId: string | null;
    mediaKind: MetadataMediaKind;
    title?: string;
    caption?: string;
    thumbnailUrl?: string;
    commentCount?: number;
    mediaCount?: number;
    preview?: MetadataPreview;
    hints: MetadataHints;
    raw?: Record<string, unknown>;
}

export interface MetadataFetchOptions {
    timeoutMs?: number;
    userAgent?: string;
    headers?: Record<string, string>;
}

export interface MetadataResolveOptions extends MetadataFetchOptions {
    allowGenericFallback?: boolean;
}
