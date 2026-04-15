import {fetchHtml} from "../http.js";
import {
    asInt,
    collapseCaption,
    extractScriptsContaining,
    extractTitle,
    findDeepMatch,
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
import {UnsupportedUrlError} from "../errors.js";

type ThreadsMedia = {
    code?: unknown;
    caption?: { text?: unknown };
    text_post_app_info?: {
        direct_reply_count?: unknown;
        is_spoiler_media?: unknown;
        text_fragments?: { fragments?: Array<Record<string, unknown>> };
    };
    image_versions2?: { candidates?: Array<{ url?: unknown; width?: unknown; height?: unknown }> };
    video_versions?: Array<{ url?: unknown; type?: unknown }>;
    carousel_media?: ThreadsMedia[];
    original_width?: unknown;
    original_height?: unknown;
    giphy_media_info?: unknown;
    is_spoiler_media?: unknown;
    media_overlay_info?: { is_spoiler_media?: unknown };
};

function isTrueLike(value: unknown): boolean {
    return value === true || value === 1 || value === "1";
}

function pickThreadsCaption(post: ThreadsMedia): string | undefined {
    const caption = typeof post.caption?.text === "string" ? post.caption.text : undefined;
    if (caption && caption.trim()) {
        return collapseCaption(caption);
    }

    const fragments = post.text_post_app_info?.text_fragments?.fragments ?? [];
    const parts: string[] = [];
    for (const fragment of fragments) {
        const plaintext = fragment.plaintext;
        if (typeof plaintext === "string" && plaintext) {
            parts.push(plaintext);
            continue;
        }
        const mention = fragment.mention_fragment && typeof (fragment.mention_fragment as {
            username?: unknown
        }).username === "string"
            ? `@${(fragment.mention_fragment as { username?: string }).username}`
            : undefined;
        if (mention) {
            parts.push(mention);
            continue;
        }
        const link = fragment.link_fragment && typeof (fragment.link_fragment as { url?: unknown }).url === "string"
            ? (fragment.link_fragment as { url?: string }).url
            : undefined;
        if (link) {
            parts.push(link);
        }
    }
    const joined = normalizeWhitespace(parts.join(""));
    return joined || undefined;
}

function pickImageCandidate(media: ThreadsMedia): { url: string; width?: number; height?: number } | undefined {
    const candidates = media.image_versions2?.candidates ?? [];
    const picked = candidates
        .filter((candidate) => typeof candidate.url === "string" && /^https?:\/\//i.test(candidate.url))
        .map((candidate) => ({
            candidate,
            score: -((asInt(candidate.width) ?? 0) * (asInt(candidate.height) ?? 0)),
        }))
        .sort((a, b) => a.score - b.score)[0]?.candidate;
    if (!picked || typeof picked.url !== "string") {
        return undefined;
    }
    return {
        url: picked.url,
        width: asInt(picked.width),
        height: asInt(picked.height),
    };
}

function pickVideoCandidate(media: ThreadsMedia): string | undefined {
    const candidates = media.video_versions ?? [];
    const prioritized = candidates
        .filter((candidate) => typeof candidate.url === "string" && /^https?:\/\//i.test(candidate.url))
        .map((candidate) => ({
            url: candidate.url as string,
            score: asInt(candidate.type) ?? 999,
        }))
        .sort((a, b) => a.score - b.score);
    return prioritized[0]?.url;
}

function isSpoilerMedia(media: ThreadsMedia, defaultValue = false): boolean {
    return isTrueLike((media.text_post_app_info as { is_spoiler_media?: unknown } | undefined)?.is_spoiler_media)
        || isTrueLike(media.is_spoiler_media)
        || isTrueLike(media.media_overlay_info?.is_spoiler_media)
        || defaultValue;
}

function extractPostFromHtml(html: string, shortcode: string): ThreadsMedia | undefined {
    const scripts = extractScriptsContaining(html, "RelayPrefetchedStreamCache");
    const candidates: ThreadsMedia[] = [];
    for (const script of scripts) {
        if (!script.includes(shortcode)) {
            continue;
        }
        try {
            const payload = JSON.parse(script);
            const found = findDeepMatch<ThreadsMedia>(payload, (candidate: ThreadsMedia) => candidate?.code === shortcode && Boolean(candidate?.text_post_app_info));
            if (found) {
                candidates.push(found);
            }
        } catch {

        }
    }
    return candidates.sort((a, b) => scorePost(b) - scorePost(a))[0];
}

function scorePost(post: ThreadsMedia): number {
    let score = 0;
    if (typeof post.caption?.text === "string" && post.caption.text.trim()) {
        score += 6;
    }
    if (post.text_post_app_info) {
        score += 6;
    }
    if (post.carousel_media?.length) {
        score += 8;
    }
    if (post.video_versions?.length) {
        score += 4;
    }
    if (post.image_versions2?.candidates?.length) {
        score += 2;
    }
    return score;
}

export class ThreadsMetadataResolver implements MetadataResolver {
    readonly platform: MetadataPlatform = "threads";

    canHandle(url: URL): boolean {
        return canonicalHostname(url.hostname).endsWith("threads.com") || canonicalHostname(url.hostname).endsWith("threads.net");
    }

    async normalize(rawInput: string, options: MetadataResolveOptions = {}): Promise<NormalizedMetadataUrl> {
        const extractedUrl = extractUrlFromText(rawInput);
        const parsed = new URL(normalizeUrlStructure(extractedUrl));
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length < 3 || !segments[0]?.startsWith("@") || segments[1] !== "post") {
            throw new UnsupportedUrlError("Only Threads post links are supported");
        }
        const mediaId = segments[2] ?? null;
        const normalizedUrl = `https://www.threads.com/${segments[0]}/post/${mediaId}`;
        return normalizeGenericUrl(rawInput, extractedUrl, normalizedUrl, "threads", mediaId);
    }

    async resolve(normalized: NormalizedMetadataUrl, options: MetadataResolveOptions = {}): Promise<ResolvedMetadata> {
        const fetched = await fetchHtml(normalized.sourceUrl, options);
        const html = fetched.html;
        const shortcode = normalized.mediaId ?? normalized.normalizedUrl.split("/").filter(Boolean).at(-1) ?? "";
        const post = extractPostFromHtml(html, shortcode);

        if (!post) {
            const caption = collapseCaption(metaFirst(html, "og:description", "twitter:description"));
            const title = titleFromCaption(caption, extractTitle(html));
            const thumbnailUrl = firstDefined(metaFirst(html, "og:image:secure_url", "og:image", "twitter:image"));
            return {
                originalInput: normalized.originalInput,
                extractedUrl: normalized.extractedUrl,
                normalizedUrl: normalized.normalizedUrl,
                sourceUrl: fetched.url || normalized.sourceUrl,
                platform: "threads",
                mediaId: normalized.mediaId,
                mediaKind: caption || title ? "text" : thumbnailUrl ? "photo" : "unknown",
                title,
                caption,
                thumbnailUrl,
                mediaCount: thumbnailUrl ? 1 : undefined,
                preview: thumbnailUrl ? {kind: "photo", url: thumbnailUrl} : undefined,
                hints: {
                    isCarousel: false,
                    isPhoto: Boolean(thumbnailUrl && !metaFirst(html, "og:video")),
                    isVideo: Boolean(metaFirst(html, "og:video")),
                    isTextOnly: Boolean(caption || title),
                    simplePhotoPreview: Boolean(thumbnailUrl && !metaFirst(html, "og:video")),
                },
                raw: {
                    pageTitle: extractTitle(html),
                    ogType: metaFirst(html, "og:type"),
                },
            };
        }

        const carousel = post.carousel_media ?? [];
        const defaultSpoiler = isSpoilerMedia(post);
        const image = pickImageCandidate(post);
        const video = pickVideoCandidate(post);
        const caption = pickThreadsCaption(post);
        const title = titleFromCaption(caption, extractTitle(html));
        const mediaKind = carousel.length > 1 ? "carousel" : video ? "video" : image ? "photo" : caption ? "text" : "unknown";
        const thumbnailUrl = image?.url ?? metaFirst(html, "og:image:secure_url", "og:image", "twitter:image");
        const replyCount = asInt(post.text_post_app_info?.direct_reply_count);
        const hasAudio = Boolean(metaFirst(html, "music:url", "og:audio"));

        return {
            originalInput: normalized.originalInput,
            extractedUrl: normalized.extractedUrl,
            normalizedUrl: normalized.normalizedUrl,
            sourceUrl: fetched.url || normalized.sourceUrl,
            platform: "threads",
            mediaId: normalized.mediaId,
            mediaKind,
            title,
            caption,
            thumbnailUrl,
            commentCount: replyCount,
            mediaCount: carousel.length || (image || video ? 1 : undefined),
            preview: image ? {
                kind: "photo",
                url: image.url,
                width: image.width,
                height: image.height
            } : video ? {kind: "video", url: video} : undefined,
            hints: {
                isCarousel: carousel.length > 1,
                isPhoto: mediaKind === "photo" || mediaKind === "carousel",
                isVideo: mediaKind === "video",
                isTextOnly: mediaKind === "text",
                simplePhotoPreview: mediaKind === "photo" && Boolean(image),
                slideshowAudioAvailable: hasAudio,
            },
            raw: {
                pageTitle: extractTitle(html),
                ogType: metaFirst(html, "og:type"),
                spoiler: defaultSpoiler,
            },
        };
    }
}

export function createThreadsMetadataResolver(): ThreadsMetadataResolver {
    return new ThreadsMetadataResolver();
}
