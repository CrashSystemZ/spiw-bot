import type {Platform, ResolvedMetadata} from "./models.js"

export function isCaptionAvailable(metadata: ResolvedMetadata): boolean {
    return Boolean(metadata.title?.trim() || metadata.description?.trim())
}

export function shouldShowCaptionByDefault(platform: Platform): boolean {
    return platform === "x" || platform === "threads"
}

export function shouldShowCaptionButton(metadata: ResolvedMetadata): boolean {
    if (isCaptionAvailable(metadata))
        return true
    if (isPrettyMetadataLoaded(metadata))
        return false
    return metadata.platform === "tiktok"
        || metadata.platform === "instagram"
        || metadata.platform === "x"
        || metadata.platform === "threads"
}

function isPrettyMetadataLoaded(metadata: ResolvedMetadata): boolean {
    return Boolean(
        metadata.title
        || metadata.thumbnailUrl
        || metadata.previewUrl
        || metadata.commentCount !== null,
    )
}
