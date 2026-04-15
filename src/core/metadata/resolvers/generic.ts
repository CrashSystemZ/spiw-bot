import {fetchHtml} from "../http.js";
import {
    absoluteUrl,
    asInt,
    collapseCaption,
    extractTitle,
    firstDefined,
    metaAll,
    metaFirst,
    titleFromCaption,
} from "../shared.js";
import {
    MetadataMediaKind,
    MetadataPlatform,
    MetadataResolveOptions,
    NormalizedMetadataUrl,
    ResolvedMetadata
} from "../../types/metadata.js";
import {MetadataResolver} from "./base.js";
import {extractUrlFromText, normalizeGenericUrl, normalizeUrlStructure} from "../url.js";

function buildHints(kind: MetadataMediaKind, mediaCount?: number, slideshowAudioAvailable?: boolean): ResolvedMetadata["hints"] {
    return {
        isCarousel: kind === "carousel" || (mediaCount !== undefined && mediaCount > 1),
        isPhoto: kind === "photo",
        isVideo: kind === "video",
        isTextOnly: kind === "text",
        simplePhotoPreview: kind === "photo" && mediaCount === 1,
        slideshowAudioAvailable,
    };
}

function inferKindFromPage(html: string): MetadataMediaKind {
    const ogVideo = metaFirst(html, "og:video", "og:video:url", "twitter:player:stream");
    if (ogVideo) {
        return "video";
    }
    const ogImage = metaFirst(html, "og:image", "twitter:image");
    if (ogImage) {
        return "photo";
    }
    return "unknown";
}

export class GenericMetadataResolver implements MetadataResolver {
    readonly platform: MetadataPlatform = "generic";

    canHandle(_url: URL): boolean {
        return true;
    }

    async normalize(rawInput: string, options: MetadataResolveOptions = {}): Promise<NormalizedMetadataUrl> {
        const extractedUrl = extractUrlFromText(rawInput);
        const normalizedUrl = normalizeUrlStructure(extractedUrl);
        const parsed = new URL(normalizedUrl);
        const mediaId = parsed.pathname.split("/").filter(Boolean).at(-1) ?? null;
        return normalizeGenericUrl(rawInput, extractedUrl, normalizedUrl, "generic", mediaId);
    }

    async resolve(normalized: NormalizedMetadataUrl, options: MetadataResolveOptions = {}): Promise<ResolvedMetadata> {
        const fetched = await fetchHtml(normalized.sourceUrl, options);
        const html = fetched.html;
        const finalUrl = fetched.url || normalized.sourceUrl;

        const ogTitle = metaFirst(html, "og:title", "twitter:title");
        const ogDescription = metaFirst(html, "og:description", "twitter:description", "description");
        const title = firstDefined(ogTitle, extractTitle(html), titleFromCaption(ogDescription, undefined));
        const caption = collapseCaption(ogDescription);
        const thumbnailUrl = firstDefined(
            metaFirst(html, "og:image:secure_url", "og:image", "twitter:image:src", "twitter:image"),
            absoluteUrl(finalUrl, metaFirst(html, "og:image", "twitter:image")),
        );
        const kind = inferKindFromPage(html);
        const mediaCount = metaAll(html, "og:image").length > 1 ? metaAll(html, "og:image").length : undefined;
        const slideshowAudioAvailable = Boolean(metaFirst(html, "music:url", "og:audio"));
        const previewUrl = kind === "photo"
            ? firstDefined(metaFirst(html, "og:image:secure_url", "og:image", "twitter:image"))
            : undefined;

        return {
            originalInput: normalized.originalInput,
            extractedUrl: normalized.extractedUrl,
            normalizedUrl: normalized.normalizedUrl,
            sourceUrl: finalUrl,
            platform: "generic",
            mediaId: normalized.mediaId,
            mediaKind: kind === "unknown" && (title || caption) ? "text" : kind,
            title,
            caption,
            thumbnailUrl,
            commentCount: asInt(metaFirst(html, "comment_count")),
            mediaCount,
            preview: previewUrl ? {kind: "photo", url: previewUrl} : undefined,
            hints: buildHints(kind === "unknown" && (title || caption) ? "text" : kind, mediaCount, slideshowAudioAvailable),
            raw: {
                pageTitle: extractTitle(html),
                ogType: metaFirst(html, "og:type"),
                ogUrl: metaFirst(html, "og:url"),
            },
        };
    }
}

export function createGenericMetadataResolver(): GenericMetadataResolver {
    return new GenericMetadataResolver();
}
