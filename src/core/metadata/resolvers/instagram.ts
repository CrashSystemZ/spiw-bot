import {fetchHtml} from "../http.js";
import {
    asInt,
    collapseCaption,
    extractTitle,
    findDeepMatch,
    firstDefined,
    metaFirst,
    normalizeWhitespace,
    pickFirstHttpUrl,
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

type InstagramMediaNode = {
    is_video?: unknown;
    video_url?: unknown;
    display_url?: unknown;
    display_resources?: Array<{ src?: unknown }>;
    video_duration?: unknown;
    dimensions?: { width?: unknown; height?: unknown };
    edge_media_to_caption?: { edges?: Array<{ node?: { text?: unknown } }> };
    edge_sidecar_to_children?: { edges?: Array<{ node?: InstagramMediaNode }> };
    edge_media_preview_comment?: { count?: unknown };
    owner?: { username?: unknown };
    shortcode_media?: InstagramMediaNode;
};

function parseCommentCount(description: string | undefined): { commentCount?: number } {
    if (!description) {
        return {};
    }
    const match = description.match(/([\d.,]+[kKmMbB]?)\s+likes?,\s+([\d.,]+[kKmMbB]?)\s+comments?/i);
    if (!match) {
        return {};
    }
    return {
        commentCount: asInt(match[2]),
    };
}

function pickCaptionFromDescription(description: string | undefined): string | undefined {
    if (!description) {
        return undefined;
    }
    const normalized = normalizeWhitespace(description);
    const quoted = normalized.match(/[“"]([^”"]+)[”"]/);
    if (quoted?.[1]) {
        return cleanInstagramCaption(quoted[1]);
    }
    const parts = normalized.split(" on Instagram: ");
    if (parts.length > 1) {
        return cleanInstagramCaption(parts.slice(1).join(" on Instagram: "));
    }
    return cleanInstagramCaption(normalized);
}

function pickMediaNode(root: unknown): InstagramMediaNode | undefined {
    return findDeepMatch<InstagramMediaNode>(root, (candidate: InstagramMediaNode) => Boolean(candidate?.shortcode_media || candidate?.edge_sidecar_to_children || candidate?.display_url || candidate?.video_url));
}

function extractInstagramState(html: string): unknown {
    const candidateScripts = [
        /window\._sharedData\s*=\s*({[\s\S]*?});/i,
        /window\.__additionalDataLoaded\s*\(\s*[^,]+,\s*({[\s\S]*?})\s*\)/i,
        /shortcode_media\s*[:=]\s*({[\s\S]*?})\s*[,;}/]/i,
    ];
    for (const pattern of candidateScripts) {
        const match = pattern.exec(html);
        if (!match?.[1]) {
            continue;
        }
        try {
            return JSON.parse(match[1]);
        } catch {

        }
    }
    return undefined;
}

function pickOwnerUsername(node: InstagramMediaNode): string | undefined {
    const username = node.owner?.username;
    return typeof username === "string" && username.trim() ? username.trim() : undefined;
}

function collectItems(node: InstagramMediaNode): InstagramMediaNode[] {
    const sidecar = node.edge_sidecar_to_children?.edges ?? [];
    if (Array.isArray(sidecar) && sidecar.length > 0) {
        return sidecar.map((entry) => entry.node).filter((entry): entry is InstagramMediaNode => Boolean(entry));
    }
    return [node];
}

function cleanInstagramCaption(value: string) {
    const collapsed = collapseCaption(value);
    if (!collapsed)
        return undefined;
    return collapsed
        .replace(/^(?:-\s*){2,}/, "")
        .replace(/\s+\.$/, "")
        .trim() || undefined;
}

export class InstagramMetadataResolver implements MetadataResolver {
    readonly platform: MetadataPlatform = "instagram";

    canHandle(url: URL): boolean {
        return canonicalHostname(url.hostname).endsWith("instagram.com");
    }

    async normalize(rawInput: string, options: MetadataResolveOptions = {}): Promise<NormalizedMetadataUrl> {
        const extractedUrl = extractUrlFromText(rawInput);
        const parsed = new URL(normalizeUrlStructure(extractedUrl));
        const path = parsed.pathname.split("/").filter(Boolean);
        if (path.length < 2 || !["p", "reel", "reels"].includes(path[0]!)) {
            throw new UnsupportedUrlError("Only Instagram posts and Reels are supported");
        }
        const canonicalPath = path[0] === "p" ? `/p/${path[1]}` : `/reel/${path[1]}`;
        const normalizedUrl = `${parsed.origin}${canonicalPath}`;
        const mediaId = path[1] ?? null;
        return normalizeGenericUrl(rawInput, extractedUrl, normalizedUrl, "instagram", mediaId);
    }

    async resolve(normalized: NormalizedMetadataUrl, options: MetadataResolveOptions = {}): Promise<ResolvedMetadata> {
        const fetched = await fetchHtml(normalized.sourceUrl, {
            ...options,
            userAgent: "Mozilla/5.0",
        });
        const html = fetched.html;
        const state = extractInstagramState(html);
        const mediaNode = state ? pickMediaNode(state) : undefined;
        const primary = mediaNode?.shortcode_media ?? mediaNode ?? undefined;

        const ogTitle = metaFirst(html, "og:title", "twitter:title");
        const ogDescription = metaFirst(html, "og:description", "description");
        const captionFromState = primary?.edge_media_to_caption?.edges?.[0]?.node?.text;
        const caption = firstDefined(
            collapseCaption(typeof captionFromState === "string" ? captionFromState : undefined),
            pickCaptionFromDescription(ogDescription),
        );
        const title = firstDefined(
            titleFromCaption(caption, ogTitle),
            ogTitle,
            primary ? `Post by ${pickOwnerUsername(primary) ?? "Instagram user"}` : undefined,
        );

        const sidecarItems = primary ? collectItems(primary) : [];
        const mediaCount = sidecarItems.length > 1 ? sidecarItems.length : undefined;
        const isVideo = Boolean(primary?.is_video);
        const thumbnailUrl = firstDefined(
            pickFirstHttpUrl(primary?.display_url),
            metaFirst(html, "og:image:secure_url", "og:image", "twitter:image"),
        );
        const commentCount = firstDefined(
            asInt(primary?.edge_media_preview_comment?.count),
            parseCommentCount(ogDescription).commentCount,
        );
        const previewUrl = !isVideo ? thumbnailUrl : firstDefined(metaFirst(html, "og:image:secure_url", "og:image"));
        const pageUrl = firstDefined(metaFirst(html, "og:url"), fetched.url, normalized.sourceUrl) ?? normalized.sourceUrl;

        return {
            originalInput: normalized.originalInput,
            extractedUrl: normalized.extractedUrl,
            normalizedUrl: normalized.normalizedUrl,
            sourceUrl: pageUrl,
            platform: "instagram",
            mediaId: normalized.mediaId,
            mediaKind: mediaCount ? "carousel" : isVideo ? "video" : "photo",
            title,
            caption,
            thumbnailUrl,
            commentCount,
            mediaCount,
            preview: previewUrl ? {kind: "photo", url: previewUrl} : undefined,
            hints: {
                isCarousel: Boolean(mediaCount && mediaCount > 1),
                isPhoto: !isVideo,
                isVideo,
                isTextOnly: false,
                simplePhotoPreview: !isVideo && !mediaCount && Boolean(previewUrl),
            },
            raw: {
                ogType: metaFirst(html, "og:type"),
                pageTitle: extractTitle(html),
            },
        };
    }
}

export function createInstagramMetadataResolver(): InstagramMetadataResolver {
    return new InstagramMetadataResolver();
}
