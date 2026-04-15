import type {GeneralTrack, ImageTrack, VideoTrack} from "mediainfo.js"
import mediaInfoFactory from "mediainfo.js"

export type MediaAnalysis = {
    kind?: "photo" | "video" | "animation" | "audio" | "document"
    duration?: number
    width?: number
    height?: number
    isAnimated?: boolean
}

export async function analyzeMediaBuffer(buffer: Buffer): Promise<MediaAnalysis> {
    const mediainfo = await mediaInfoFactory()
    try {
        const result = await mediainfo.analyzeData(
            buffer.byteLength,
            (size, offset) => buffer.slice(offset, offset + size),
        )

        const general = result.media?.track.find((track): track is GeneralTrack => track["@type"] === "General")
        if (!general)
            return {}

        if (general.VideoCount) {
            const video = result.media?.track.find((track): track is VideoTrack => track["@type"] === "Video")
            return {
                kind: "video",
                duration: toFiniteNumber(general.Duration),
                width: toFiniteNumber(video?.Width),
                height: toFiniteNumber(video?.Height),
            }
        }

        if (general.AudioCount) {
            return {
                kind: "audio",
                duration: toFiniteNumber(general.Duration),
            }
        }

        if (general.ImageCount) {
            const image = result.media?.track.find((track): track is ImageTrack => track["@type"] === "Image")
            if (image?.Format === "GIF") {
                return {
                    kind: "animation",
                    duration: toFiniteNumber(general.Duration),
                    width: toFiniteNumber(image.Width),
                    height: toFiniteNumber(image.Height),
                    isAnimated: true,
                }
            }

            return {
                kind: "photo",
                width: toFiniteNumber(image?.Width),
                height: toFiniteNumber(image?.Height),
            }
        }

        return {}
    } finally {
        mediainfo.close()
    }
}

function toFiniteNumber(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value))
        return value
    if (typeof value === "string") {
        const parsed = Number.parseFloat(value)
        if (Number.isFinite(parsed))
            return parsed
    }
    return undefined
}
