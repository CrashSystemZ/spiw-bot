import {fetchHtml, followRedirect} from "../http.js";
import {
    asInt,
    collapseCaption,
    DEFAULT_USER_AGENT,
    findDeepMatch,
    firstDefined,
    metaFirst,
    pickFirstHttpUrl,
    safeJsonParse,
    titleFromCaption,
} from "../shared.js";
import {
    MetadataPlatform,
    MetadataResolveOptions,
    NormalizedMetadataUrl,
    ResolvedMetadata
} from "../../types/metadata.js";
import {MetadataResolver} from "./base.js";
import {MetadataUnavailableError, UnsupportedUrlError} from "../errors.js";
import {canonicalHostname, extractUrlFromText, normalizeGenericUrl, normalizeUrlStructure} from "../url.js";
import {logError, logInfo, logWarn} from "../../log.js";

type TikTokImage = {
    imageURL?: { urlList?: string[] };
    imageWidth?: unknown;
    imageHeight?: unknown;
};

type TikTokItemStruct = {
    desc?: unknown;
    stats?: Record<string, unknown>;
    music?: {
        playUrl?: unknown;
        play_url?: unknown;
        duration?: unknown;
    };
    imagePost?: {
        title?: unknown;
        cover?: {
            imageURL?: { urlList?: string[] };
        };
        images?: TikTokImage[];
    };
    video?: Record<string, unknown>;
    cover?: { urlList?: string[] };
    author?: Record<string, unknown>;
};

type TikTokPlayerApiImage = {
    display_image?: {
        url_list?: string[];
        width?: unknown;
        height?: unknown;
    };
    thumbnail?: {
        url_list?: string[];
        width?: unknown;
        height?: unknown;
    };
    owner_watermark_image?: {
        url_list?: string[];
        width?: unknown;
        height?: unknown;
    };
};

type TikTokPlayerApiItem = {
    id?: unknown;
    id_str?: unknown;
    aweme_type?: unknown;
    desc?: unknown;
    statistics_info?: Record<string, unknown>;
    image_post_info?: {
        cover?: {
            display_image?: {
                url_list?: string[];
            };
        };
        images?: TikTokPlayerApiImage[];
    };
    video_info?: {
        cover?: {
            url_list?: string[];
        };
        origin_cover?: {
            url_list?: string[];
        };
        url_list?: string[];
    };
    music_info?: {
        id?: unknown;
        id_str?: unknown;
        title?: unknown;
        author?: unknown;
    };
};

type TikTokPlayerApiResponse = {
    items?: TikTokPlayerApiItem[];
};

type TimeoutHandle = {
    signal?: AbortSignal;
    cleanup: () => void;
};

function pickUrlList(value: unknown): string | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const list = (value as { urlList?: unknown }).urlList;
    if (!Array.isArray(list)) {
        return undefined;
    }
    return list.find((entry) => typeof entry === "string" && /^https?:\/\//i.test(entry));
}

function pickTikTokImage(item: TikTokImage): string | undefined {
    return pickUrlList(item.imageURL);
}

function pickStringArrayUrl(list: unknown): string | undefined {
    if (!Array.isArray(list)) {
        return undefined;
    }
    return list.find((entry) => typeof entry === "string" && /^https?:\/\//i.test(entry));
}

function guessMediaKind(itemStruct: TikTokItemStruct): "video" | "photo" | "carousel" | "unknown" {
    const images = itemStruct.imagePost?.images ?? [];
    if (images.length > 1) {
        return "carousel";
    }
    if (images.length === 1) {
        return "photo";
    }
    if (itemStruct.video || itemStruct.cover) {
        return "video";
    }
    return "unknown";
}

function extractItemStruct(html: string): TikTokItemStruct | undefined {
    const apiScript = safeJsonParse(findScriptPayloadById(html, "api-data"));
    const nestedApiItem = findDeepMatch<TikTokItemStruct>(apiScript, (candidate: TikTokItemStruct) => Boolean(candidate?.imagePost || candidate?.video));
    if (nestedApiItem) {
        return nestedApiItem;
    }

    const hydrationScript = safeJsonParse(findScriptPayloadById(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__"));
    const hydrationItem = findDeepMatch<TikTokItemStruct>(hydrationScript, (candidate: TikTokItemStruct) => Boolean(candidate?.imagePost || candidate?.video));
    if (hydrationItem) {
        return hydrationItem;
    }
    return undefined;
}

function findScriptPayloadById(html: string, id: string): string | undefined {
    const pattern = new RegExp(`<script\\b[^>]*id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i");
    const match = pattern.exec(html);
    return match?.[1];
}

function findTikTokPageUrl(html: string): string | undefined {
    return firstDefined(
        metaFirst(html, "og:url"),
        metaFirst(html, "al:ios:url"),
        metaFirst(html, "al:android:url"),
    );
}

function makeTimeoutSignal(timeoutMs: number | undefined): TimeoutHandle {
    if (!timeoutMs || timeoutMs <= 0) {
        return {cleanup: () => undefined};
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
    };
}

function isPhotoAwemeType(value: unknown): boolean {
    return value === 150 || value === 152 || value === "150" || value === "152";
}

function buildTikTokPlayerApiUrl(mediaId: string): string {
    const url = new URL("https://www.tiktok.com/player/api/v1/items");
    url.searchParams.set("item_ids", mediaId);
    url.searchParams.set("aid", "1284");
    url.searchParams.set("app_name", "tiktok_web");
    return url.toString();
}

async function fetchPlayerApiItem(mediaId: string, pageUrl: string, options: MetadataResolveOptions = {}): Promise<TikTokPlayerApiItem | undefined> {
    const {signal, cleanup} = makeTimeoutSignal(options.timeoutMs);
    const apiUrl = buildTikTokPlayerApiUrl(mediaId);
    logInfo("metadata.tiktok.player_api.start", {
        mediaId,
        apiUrl,
        pageUrl,
        timeoutMs: options.timeoutMs ?? null,
    });
    try {
        const response = await fetch(apiUrl, {
            method: "GET",
            redirect: "follow",
            signal,
            headers: {
                "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
                accept: "application/json, text/plain, */*",
                referer: pageUrl,
                origin: "https://www.tiktok.com",
                ...options.headers,
            },
        });
        if (!response.ok) {
            logWarn("metadata.tiktok.player_api.http_error", {
                mediaId,
                apiUrl,
                status: response.status,
            });
            return undefined;
        }

        const payload = (await response.json()) as TikTokPlayerApiResponse;
        const item = Array.isArray(payload.items)
            ? payload.items.find((candidate) => String(candidate?.id_str ?? candidate?.id ?? "") === mediaId) ?? payload.items[0]
            : undefined;

        logInfo("metadata.tiktok.player_api.ok", {
            mediaId,
            apiUrl,
            hasItem: Boolean(item),
            itemCount: Array.isArray(payload.items) ? payload.items.length : 0,
            awemeType: item?.aweme_type ?? null,
            hasStats: Boolean(item?.statistics_info),
            hasImagePost: Boolean(item?.image_post_info),
            hasVideoInfo: Boolean(item?.video_info),
        });
        return item;
    } catch (error) {
        logError("metadata.tiktok.player_api.failed", error, {
            mediaId,
            apiUrl,
            pageUrl,
        });
        return undefined;
    } finally {
        cleanup();
    }
}

function mapPlayerApiItemToStruct(item: TikTokPlayerApiItem): TikTokItemStruct {
    const images = Array.isArray(item.image_post_info?.images)
        ? item.image_post_info.images.map((image) => ({
            imageURL: {
                urlList: image.display_image?.url_list
                    ?? image.thumbnail?.url_list
                    ?? image.owner_watermark_image?.url_list,
            },
            imageWidth: image.display_image?.width
                ?? image.thumbnail?.width
                ?? image.owner_watermark_image?.width,
            imageHeight: image.display_image?.height
                ?? image.thumbnail?.height
                ?? image.owner_watermark_image?.height,
        }))
        : undefined;

    const hasVideo = Boolean(item.video_info) || isPhotoAwemeType(item.aweme_type);
    return {
        desc: item.desc,
        stats: item.statistics_info
            ? {
                diggCount: item.statistics_info.digg_count,
                commentCount: item.statistics_info.comment_count,
                shareCount: item.statistics_info.share_count,
            }
            : undefined,
        imagePost: item.image_post_info
            ? {
                cover: {
                    imageURL: {
                        urlList: item.image_post_info.cover?.display_image?.url_list,
                    },
                },
                images,
            }
            : undefined,
        video: hasVideo ? (item.video_info ?? {}) : undefined,
        cover: {
            urlList: item.video_info?.cover?.url_list
                ?? item.video_info?.origin_cover?.url_list,
        },
        music: item.music_info
            ? {
                duration: undefined,
                playUrl: undefined,
                play_url: undefined,
            }
            : undefined,
    };
}

export class TikTokMetadataResolver implements MetadataResolver {
    readonly platform: MetadataPlatform = "tiktok";

    canHandle(url: URL): boolean {
        return canonicalHostname(url.hostname).endsWith("tiktok.com");
    }

    async normalize(rawInput: string, options: MetadataResolveOptions = {}): Promise<NormalizedMetadataUrl> {
        const extractedUrl = extractUrlFromText(rawInput);
        const normalizedCandidate = normalizeUrlStructure(extractedUrl);
        const parsed = new URL(normalizedCandidate);
        const host = canonicalHostname(parsed.hostname);

        let sourceUrl = normalizedCandidate;
        if (host === "vm.tiktok.com" || host === "vt.tiktok.com" || parsed.pathname.startsWith("/t/")) {
            sourceUrl = await followRedirect(normalizedCandidate, options);
        }

        const finalUrl = normalizeUrlStructure(sourceUrl);
        const finalParsed = new URL(finalUrl);
        const segments = finalParsed.pathname.split("/").filter(Boolean);
        const mediaIndex = segments.findIndex((segment) => segment === "video" || segment === "photo");
        if (mediaIndex < 0 || mediaIndex + 1 >= segments.length) {
            throw new UnsupportedUrlError("Only TikTok video and photo links are supported");
        }

        const mediaId = segments[mediaIndex + 1] ?? null;
        const normalizedUrl = finalParsed.searchParams.get("story_type") === "1" || finalParsed.searchParams.has("share_item_id") || finalParsed.searchParams.has("story_uid")
            ? finalUrl.replace(/\?.*$/, `?${Array.from(finalParsed.searchParams.entries())
                .filter(([key]) => key !== "feature" && key !== "si")
                .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                .join("&")}`)
            : `${finalParsed.origin}/${segments.slice(0, mediaIndex + 2).join("/")}`;

        return normalizeGenericUrl(rawInput, extractedUrl, normalizedUrl, "tiktok", mediaId);
    }

    async resolve(normalized: NormalizedMetadataUrl, options: MetadataResolveOptions = {}): Promise<ResolvedMetadata> {
        const playerItem = normalized.mediaId
            ? await fetchPlayerApiItem(normalized.mediaId, normalized.normalizedUrl, options)
            : undefined;

        if (playerItem) {
            const itemStruct = mapPlayerApiItemToStruct(playerItem);
            const imagePost = itemStruct.imagePost ?? {};
            const images = imagePost.images ?? [];
            const thumbnailUrl = firstDefined(
                pickUrlList(imagePost.cover?.imageURL),
                pickUrlList((itemStruct.cover as { urlList?: string[] } | undefined) ?? undefined),
                pickStringArrayUrl(playerItem.video_info?.origin_cover?.url_list),
                pickStringArrayUrl(playerItem.video_info?.cover?.url_list),
            );
            const description = collapseCaption(String(playerItem.desc ?? itemStruct.desc ?? ""));
            const title = titleFromCaption(description, description);
            const kind = guessMediaKind(itemStruct);
            const previewUrl = kind === "photo"
                ? firstDefined(pickTikTokImage(images[0] ?? {}), thumbnailUrl)
                : thumbnailUrl;
            const commentCount = asInt(playerItem.statistics_info?.comment_count ?? itemStruct.stats?.commentCount);

            return {
                originalInput: normalized.originalInput,
                extractedUrl: normalized.extractedUrl,
                normalizedUrl: normalized.normalizedUrl,
                sourceUrl: normalized.normalizedUrl,
                platform: "tiktok",
                mediaId: normalized.mediaId,
                mediaKind: kind,
                title,
                caption: description,
                thumbnailUrl,
                commentCount,
                mediaCount: images.length || undefined,
                preview: previewUrl ? {kind: "photo", url: previewUrl} : undefined,
                hints: {
                    isCarousel: kind === "carousel",
                    isPhoto: kind === "photo" || kind === "carousel",
                    isVideo: kind === "video",
                    isTextOnly: false,
                    simplePhotoPreview: kind === "photo" && images.length === 1 && !!previewUrl,
                    slideshowAudioAvailable: Boolean(playerItem.music_info && images.length > 0),
                },
                raw: {
                    awemeType: playerItem.aweme_type ?? null,
                    metadataSource: "player_api",
                },
            };
        }

        const fetched = await fetchHtml(normalized.sourceUrl, options);
        const html = fetched.html;
        const itemStruct = extractItemStruct(html);

        if (!itemStruct) {
            throw new MetadataUnavailableError("TikTok page metadata was not found");
        }

        const imagePost = itemStruct.imagePost ?? {};
        const images = imagePost.images ?? [];
        const thumbnailUrl = firstDefined(
            pickUrlList(imagePost.cover?.imageURL),
            pickUrlList((itemStruct.cover as { urlList?: string[] } | undefined) ?? undefined),
            metaFirst(html, "og:image:secure_url", "og:image"),
        );
        const description = collapseCaption(String(itemStruct.desc ?? metaFirst(html, "og:description") ?? ""));
        const title = titleFromCaption(collapseCaption(String(imagePost.title ?? itemStruct.desc ?? "")), description);
        const kind = guessMediaKind(itemStruct);
        const finalUrl = findTikTokPageUrl(html) ?? fetched.url ?? normalized.sourceUrl;
        const commentCount = asInt(itemStruct.stats?.commentCount ?? itemStruct.stats?.comment_count ?? metaFirst(html, "comment_count"));
        const musicUrl = pickFirstHttpUrl(itemStruct.music?.playUrl, itemStruct.music?.play_url);
        const previewUrl = kind === "photo"
            ? firstDefined(pickTikTokImage(images[0] ?? {}), thumbnailUrl)
            : thumbnailUrl;

        return {
            originalInput: normalized.originalInput,
            extractedUrl: normalized.extractedUrl,
            normalizedUrl: normalized.normalizedUrl,
            sourceUrl: finalUrl,
            platform: "tiktok",
            mediaId: normalized.mediaId,
            mediaKind: kind,
            title,
            caption: description,
            thumbnailUrl,
            commentCount,
            mediaCount: images.length || undefined,
            preview: previewUrl ? {kind: "photo", url: previewUrl} : undefined,
            hints: {
                isCarousel: kind === "carousel",
                isPhoto: kind === "photo" || kind === "carousel",
                isVideo: kind === "video",
                isTextOnly: false,
                simplePhotoPreview: kind === "photo" && images.length === 1 && !!previewUrl,
                slideshowAudioAvailable: Boolean(musicUrl && images.length > 0),
            },
            raw: {
                pageTitle: metaFirst(html, "og:title"),
                ogUrl: metaFirst(html, "og:url"),
            },
        };
    }
}

export function createTikTokMetadataResolver(): TikTokMetadataResolver {
    return new TikTokMetadataResolver();
}
