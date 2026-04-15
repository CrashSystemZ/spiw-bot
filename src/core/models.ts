export type Platform = "tiktok" | "instagram" | "x" | "threads" | "generic"

export type MediaKind = "photo" | "video" | "animation" | "audio" | "document"

export type PreviewKind = "photo" | "video" | "animation"

export type MetadataItem = {
    kind: PreviewKind
    sourceUrl?: string
    thumbnailUrl?: string
}

export type ResolvedMetadata = {
    platform: Platform
    cacheKey: string
    originalUrl: string
    normalizedUrl: string
    sourceUrl: string
    title: string | null
    description: string | null
    thumbnailUrl: string | null
    commentCount: number | null
    previewUrl: string | null
    previewKind: PreviewKind | null
    items: MetadataItem[]
}

export type PendingRequestRecord = {
    id: string
    authorId: number
    rawQuery: string
    cacheKey: string
    normalizedUrl: string
    sourceUrl: string
    createdAt: number
}

export type CachedMetadataRecord = {
    cacheKey: string
    createdAt: number
    value: ResolvedMetadata
}

export type CachedRehydrateRecord = {
    cacheKey: string
    createdAt: number
    value: ResolvedMetadata
}

export type UiStateMode = "media" | "audio"

export type UiStateRecord = {
    token: string
    cacheKey: string
    captionVisible: boolean
    mode: UiStateMode
    index: number
    createdAt: number
}

export type DeliveryStats = {
    last24Hours: number
    allTime: number
}

export type SessionMediaItem = {
    id: string
    kind: MediaKind
    fileName: string
    mimeType: string | null
    buffer: Buffer
    width?: number
    height?: number
    duration?: number
    isAnimated?: boolean
}

export type SessionAudioTrack = {
    fileName: string
    mimeType: string | null
    buffer: Buffer
    duration?: number
}

export type SessionEntry = {
    cacheKey: string
    metadata: ResolvedMetadata
    items: SessionMediaItem[]
    audio: SessionAudioTrack | null
    createdAt: number
    expiresAt: number
    sizeBytes: number
}

export type InlineRequestContext = {
    requestId: string
    metadata: ResolvedMetadata
    request: PendingRequestRecord
}
