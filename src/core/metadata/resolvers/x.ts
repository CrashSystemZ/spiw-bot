import {fetchHtml} from "../http.js";
import {
    asInt,
    collapseCaption,
    extractTitle,
    firstDefined,
    metaFirst,
    normalizeWhitespace,
    titleFromCaption,
} from "../shared.js";
import {
    MetadataPlatform,
    MetadataResolveOptions,
    NormalizedMetadataUrl,
    ResolvedMetadata
} from "../../types/metadata.js";
import {MetadataResolver} from "./base.js";
import {canonicalHostname, extractUrlFromText, normalizeGenericUrl, normalizeUrlStructure} from "../url.js";
import {MetadataUnavailableError, UnsupportedUrlError} from "../errors.js";
import {logInfo, logWarn} from "../../log.js";

type XSyndicationPhoto = {
    url?: unknown;
    width?: unknown;
    height?: unknown;
};

type XSyndicationTweet = {
    id_str?: unknown;
    text?: unknown;
    conversation_count?: unknown;
    photos?: XSyndicationPhoto[];
};

function pickTweetText(tweet: XSyndicationTweet): string | undefined {
    return typeof tweet.text === "string" && tweet.text.trim()
        ? normalizeWhitespace(tweet.text)
        : undefined;
}

function guessKind(tweet: XSyndicationTweet, hasText: boolean): "photo" | "text" | "unknown" {
    if (Array.isArray(tweet.photos) && tweet.photos.length > 0) {
        return tweet.photos.length > 1 ? "carousel" as never : "photo";
    }
    return hasText ? "text" : "unknown";
}

function buildSyndicationToken(tweetId: string) {
    const numericId = Number(tweetId);
    if (!Number.isFinite(numericId) || numericId <= 0)
        return "1";
    return ((numericId / 1e15) * Math.PI)
        .toString(36)
        .replace(/(0\.|[^a-z]+)/g, "") || "1";
}

async function fetchSyndicationTweet(tweetId: string, options: MetadataResolveOptions = {}) {
    const url = new URL("https://cdn.syndication.twimg.com/tweet-result");
    url.searchParams.set("id", tweetId);
    url.searchParams.set("lang", "en");
    url.searchParams.set("token", buildSyndicationToken(tweetId));

    logInfo("metadata.x.syndication.request", {
        tweetId,
        url: url.toString(),
    });

    const response = await fetch(url, {
        method: "GET",
        headers: {
            "user-agent": options.userAgent ?? "Mozilla/5.0",
            accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
            ...options.headers,
        },
    });

    const body = await response.json().catch(() => null) as XSyndicationTweet | null;
    logInfo("metadata.x.syndication.response", {
        tweetId,
        status: response.status,
        body,
    });

    if (!response.ok || !body || typeof body !== "object" || !Object.keys(body).length) {
        throw new MetadataUnavailableError("X syndication lookup failed");
    }

    return body;
}

export class XMetadataResolver implements MetadataResolver {
    readonly platform: MetadataPlatform = "x";

    canHandle(url: URL): boolean {
        return canonicalHostname(url.hostname).endsWith("x.com") || canonicalHostname(url.hostname).endsWith("twitter.com");
    }

    async normalize(rawInput: string, options: MetadataResolveOptions = {}): Promise<NormalizedMetadataUrl> {
        const extractedUrl = extractUrlFromText(rawInput);
        const parsed = new URL(normalizeUrlStructure(extractedUrl));
        const segments = parsed.pathname.split("/").filter(Boolean);
        const statusIndex = segments.indexOf("status");
        if (statusIndex < 1 || statusIndex + 1 >= segments.length) {
            throw new UnsupportedUrlError("Only X status links are supported");
        }

        const handle = segments[statusIndex - 1];
        const mediaId = segments[statusIndex + 1] ?? null;
        const normalizedUrl = `https://x.com/${handle}/status/${mediaId}`;
        return normalizeGenericUrl(rawInput, extractedUrl, normalizedUrl, "x", mediaId);
    }

    async resolve(normalized: NormalizedMetadataUrl, options: MetadataResolveOptions = {}): Promise<ResolvedMetadata> {
        const tweetId = normalized.mediaId
        if (tweetId) {
            try {
                const tweet = await fetchSyndicationTweet(tweetId, options);
                const caption = collapseCaption(pickTweetText(tweet));
                const title = titleFromCaption(caption, undefined);
                const thumbnailUrl = Array.isArray(tweet.photos) && tweet.photos[0] && typeof tweet.photos[0].url === "string"
                    ? tweet.photos[0].url
                    : undefined;
                const mediaCount = Array.isArray(tweet.photos) && tweet.photos.length ? tweet.photos.length : undefined;
                const kind = guessKind(tweet, Boolean(caption));

                return {
                    originalInput: normalized.originalInput,
                    extractedUrl: normalized.extractedUrl,
                    normalizedUrl: normalized.normalizedUrl,
                    sourceUrl: normalized.sourceUrl,
                    platform: "x",
                    mediaId: normalized.mediaId,
                    mediaKind: kind,
                    title,
                    caption,
                    thumbnailUrl,
                    commentCount: asInt(tweet.conversation_count),
                    mediaCount,
                    preview: thumbnailUrl ? {kind: "photo", url: thumbnailUrl} : undefined,
                    hints: {
                        isCarousel: Boolean(mediaCount && mediaCount > 1),
                        isPhoto: kind === "photo",
                        isVideo: false,
                        isTextOnly: kind === "text",
                        simplePhotoPreview: kind === "photo" && mediaCount === 1,
                    },
                    raw: {
                        tweetId,
                        syndication: true,
                    },
                };
            } catch (error) {
                logWarn("metadata.x.syndication.failed", {
                    tweetId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        const fetched = await fetchHtml(normalized.sourceUrl, options);
        const html = fetched.html;
        const title = firstDefined(metaFirst(html, "og:title", "twitter:title"), extractTitle(html));
        const caption = collapseCaption(metaFirst(html, "og:description", "twitter:description"));
        const thumbnailUrl = firstDefined(metaFirst(html, "og:image:secure_url", "og:image", "twitter:image"), undefined);

        logWarn("metadata.x.html_fallback", {
            mediaId: normalized.mediaId,
            title,
            caption,
            thumbnailUrl,
        });

        return {
            originalInput: normalized.originalInput,
            extractedUrl: normalized.extractedUrl,
            normalizedUrl: normalized.normalizedUrl,
            sourceUrl: fetched.url || normalized.sourceUrl,
            platform: "x",
            mediaId: normalized.mediaId,
            mediaKind: caption || title ? "text" : thumbnailUrl ? "photo" : "unknown",
            title: titleFromCaption(caption, title),
            caption,
            thumbnailUrl,
            mediaCount: thumbnailUrl ? 1 : undefined,
            preview: thumbnailUrl ? {kind: "photo", url: thumbnailUrl} : undefined,
            hints: {
                isCarousel: false,
                isPhoto: Boolean(thumbnailUrl),
                isVideo: false,
                isTextOnly: Boolean(caption || title),
                simplePhotoPreview: Boolean(thumbnailUrl),
            },
            raw: {
                pageTitle: extractTitle(html),
                ogType: metaFirst(html, "og:type"),
            },
        };
    }
}

export function createXMetadataResolver(): XMetadataResolver {
    return new XMetadataResolver();
}
