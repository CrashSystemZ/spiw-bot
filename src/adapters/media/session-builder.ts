import pLimit from "p-limit"

import { env } from "../../config/env.js"
import { CobaltClient, cobaltErrorToDomain, inferMediaKind } from "../../core/cobalt.js"
import { MediaUnavailableError } from "../../core/errors.js"
import { logDebug, logInfo } from "../../core/log.js"
import { analyzeMediaBuffer } from "../../core/media-info.js"
import type { ResolvedMetadata, SessionAudioTrack, SessionEntry, SessionMediaItem } from "../../core/models.js"

export class MediaSessionBuilder {
    readonly #cobalt: CobaltClient

    constructor(cobalt: CobaltClient, private readonly rehydrateTtlMs: number) {
        this.#cobalt = cobalt
    }

    async build(metadata: ResolvedMetadata): Promise<SessionEntry> {
        const response = await this.#cobalt.resolve({
            url: metadata.normalizedUrl,
            downloadMode: "auto",
        })

        logInfo("runtime.session.cobalt_response", {
            cacheKey: metadata.cacheKey,
            status: response.status,
            response,
        })

        if (response.status === "error")
            throw cobaltErrorToDomain(response.error.code)

        if (response.status === "local-processing")
            throw new MediaUnavailableError("local_processing")

        if (response.status === "picker") {
            const limit = pLimit(env.MAX_FETCHES_PER_JOB)
            const items = await Promise.all(response.picker.map((item, index) => limit(async () => {
                const fileName = fileNameFromUrl(item.url, `item-${index + 1}`)
                const downloaded = await this.#cobalt.fetchBinary(item.url, fileName, env.MAX_MEDIA_ITEM_BYTES)
                const analysis = await analyzeMediaBuffer(downloaded.buffer)
                logDebug("runtime.session.picker_item_downloaded", {
                    cacheKey: metadata.cacheKey,
                    index,
                    sourceUrl: item.url,
                    fileName: downloaded.fileName,
                    mimeType: downloaded.mimeType,
                    sizeBytes: downloaded.sizeBytes,
                    analysis,
                })
                return {
                    id: `item-${index}`,
                    kind: analysis.kind ?? inferMediaKind(downloaded.fileName, downloaded.mimeType, item.type === "gif" ? "gif" : item.type),
                    fileName: downloaded.fileName,
                    mimeType: downloaded.mimeType,
                    buffer: downloaded.buffer,
                    sizeBytes: downloaded.sizeBytes,
                    width: analysis.width,
                    height: analysis.height,
                    duration: analysis.duration,
                    isAnimated: analysis.isAnimated ?? (item.type === "gif"),
                }
            })))

            let audio: SessionAudioTrack | null = null
            if (response.audio) {
                const audioDownloaded = await this.#cobalt.fetchBinary(
                    response.audio,
                    response.audioFilename ?? fileNameFromUrl(response.audio, "audio-track"),
                    env.MAX_MEDIA_ITEM_BYTES,
                )
                logDebug("runtime.session.audio_downloaded", {
                    cacheKey: metadata.cacheKey,
                    fileName: audioDownloaded.fileName,
                    mimeType: audioDownloaded.mimeType,
                    sizeBytes: audioDownloaded.sizeBytes,
                })
                audio = {
                    fileName: audioDownloaded.fileName,
                    mimeType: audioDownloaded.mimeType,
                    buffer: audioDownloaded.buffer,
                }
            }

            return {
                cacheKey: metadata.cacheKey,
                metadata,
                items: items.map(stripItemSize),
                audio,
                createdAt: Date.now(),
                expiresAt: Date.now() + this.rehydrateTtlMs,
                sizeBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0) + (audio?.buffer.byteLength ?? 0),
            }
        }

        const downloaded = await this.#cobalt.fetchBinary(response.url, response.filename, env.MAX_MEDIA_ITEM_BYTES)
        const analysis = await analyzeMediaBuffer(downloaded.buffer)
        logDebug("runtime.session.single_downloaded", {
            cacheKey: metadata.cacheKey,
            sourceUrl: response.url,
            fileName: downloaded.fileName,
            mimeType: downloaded.mimeType,
            sizeBytes: downloaded.sizeBytes,
            analysis,
        })
        const item: SessionMediaItem = {
            id: "item-0",
            kind: analysis.kind ?? inferMediaKind(downloaded.fileName, downloaded.mimeType),
            fileName: downloaded.fileName,
            mimeType: downloaded.mimeType,
            buffer: downloaded.buffer,
            width: analysis.width,
            height: analysis.height,
            duration: analysis.duration,
            isAnimated: analysis.isAnimated,
        }

        return {
            cacheKey: metadata.cacheKey,
            metadata,
            items: [item],
            audio: null,
            createdAt: Date.now(),
            expiresAt: Date.now() + this.rehydrateTtlMs,
            sizeBytes: downloaded.sizeBytes,
        }
    }
}

function fileNameFromUrl(url: string, fallback: string) {
    const pathname = new URL(url).pathname
    const last = pathname.split("/").filter(Boolean).at(-1)
    return last || fallback
}

function stripItemSize(item: SessionMediaItem & { sizeBytes: number }): SessionMediaItem {
    const { sizeBytes: _sizeBytes, ...rest } = item
    return rest
}
