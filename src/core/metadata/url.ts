import {ensureHttps, extractFirstHttpUrl, trimUrl,} from "./shared.js";
import {MetadataPlatform} from "../types/metadata.js";
import {UnsupportedUrlError} from "./errors.js";

export interface UrlNormalizationResult {
    originalInput: string;
    extractedUrl: string;
    normalizedUrl: string;
    sourceUrl: string;
    platform: MetadataPlatform;
    mediaId: string | null;
}

export function extractUrlFromText(rawInput: string): string {
    const trimmed = (rawInput ?? "").trim();
    if (!trimmed) {
        throw new UnsupportedUrlError("No URL was found in the input");
    }

    const candidate = trimmed.startsWith("https://")
        ? trimmed.split(/\s+/u)[0]
        : extractFirstHttpUrl(trimmed);

    if (!candidate) {
        throw new UnsupportedUrlError("No URL was found in the input");
    }
    return trimUrl(ensureHttps(candidate));
}

export function normalizeGenericUrl(originalInput: string, extractedUrl: string, normalizedUrl: string, platform: MetadataPlatform, mediaId: string | null): UrlNormalizationResult {
    return {
        originalInput,
        extractedUrl,
        normalizedUrl,
        sourceUrl: normalizedUrl,
        platform,
        mediaId,
    };
}

export function normalizeUrlStructure(candidate: string): string {
    const url = new URL(ensureHttps(candidate));
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
        url.pathname = url.pathname.replace(/\/+$/g, "");
    }
    return url.toString();
}

export function canonicalHostname(hostname: string): string {
    return hostname.toLowerCase().replace(/^www\./, "");
}
