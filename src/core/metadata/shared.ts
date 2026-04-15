export const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

const META_TAG_RE = /<meta\b[^>]*>/gi;
const TITLE_TAG_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const SCRIPT_TAG_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

export function stripTags(value: string): string {
    return value.replace(/<[^>]+>/g, " ");
}

export function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function parseAttributes(tag: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTR_RE.exec(tag)) !== null) {
        const key = match[1]?.toLowerCase();
        if (!key) {
            continue;
        }
        const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
        attrs[key] = decodeHtmlEntities(rawValue);
    }
    return attrs;
}

export function extractMetaValues(html: string): Map<string, string[]> {
    const values = new Map<string, string[]>();
    const tags = html.match(META_TAG_RE) ?? [];
    for (const tag of tags) {
        const attrs = parseAttributes(tag);
        const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? "").trim().toLowerCase();
        const content = (attrs.content ?? attrs.value ?? "").trim();
        if (!key || !content) {
            continue;
        }
        const bucket = values.get(key) ?? [];
        bucket.push(content);
        values.set(key, bucket);
    }
    return values;
}

export function metaFirst(html: string, ...keys: string[]): string | undefined {
    const values = extractMetaValues(html);
    for (const key of keys) {
        const value = values.get(key.toLowerCase())?.find(Boolean);
        if (value) {
            return normalizeWhitespace(decodeHtmlEntities(value));
        }
    }
    return undefined;
}

export function metaAll(html: string, key: string): string[] {
    return (extractMetaValues(html).get(key.toLowerCase()) ?? [])
        .map((value) => normalizeWhitespace(decodeHtmlEntities(value)))
        .filter(Boolean);
}

export function extractTitle(html: string): string | undefined {
    const match = TITLE_TAG_RE.exec(html);
    if (!match?.[1]) {
        return undefined;
    }
    return normalizeWhitespace(decodeHtmlEntities(stripTags(match[1])));
}

export function extractScriptsContaining(html: string, needle: string): string[] {
    const scripts: string[] = [];
    SCRIPT_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SCRIPT_TAG_RE.exec(html)) !== null) {
        const body = match[1] ?? "";
        if (body.includes(needle)) {
            scripts.push(body);
        }
    }
    return scripts;
}

export function safeJsonParse(script: string | undefined): unknown | undefined {
    if (!script) {
        return undefined;
    }
    try {
        return JSON.parse(script.trim());
    } catch {
        return undefined;
    }
}

export function findDeepMatch<T>(value: unknown, predicate: (candidate: T) => boolean): T | undefined {
    const seen = new Set<object>();
    const walk = (node: unknown): T | undefined => {
        if (!node || typeof node !== "object") {
            return undefined;
        }
        if (seen.has(node as object)) {
            return undefined;
        }
        seen.add(node as object);

        if (predicate(node as T)) {
            return node as T;
        }
        if (Array.isArray(node)) {
            for (const entry of node) {
                const found = walk(entry);
                if (found !== undefined) {
                    return found;
                }
            }
            return undefined;
        }
        for (const entry of Object.values(node as Record<string, unknown>)) {
            const found = walk(entry);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    };
    return walk(value);
}

export function extractFirstHttpUrl(text: string): string | undefined {
    const match = text.match(/https?:\/\/[^\s<>"']+/i);
    if (!match?.[0]) {
        return undefined;
    }
    return trimUrl(match[0]);
}

export function trimUrl(candidate: string): string {
    return candidate.trim().replace(/[.,;!?)+>\]]+$/g, "");
}

export function ensureHttps(candidate: string): string {
    return candidate.startsWith("http://") ? `https://${candidate.slice("http://".length)}` : candidate;
}

export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pickFirstHttpUrl(...values: Array<unknown>): string | undefined {
    for (const value of values) {
        if (typeof value === "string" && /^https?:\/\//i.test(value)) {
            return value;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                const found = pickFirstHttpUrl(item);
                if (found) {
                    return found;
                }
            }
        }
        if (value && typeof value === "object") {
            for (const item of Object.values(value as Record<string, unknown>)) {
                const found = pickFirstHttpUrl(item);
                if (found) {
                    return found;
                }
            }
        }
    }
    return undefined;
}

export function safeUrl(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        if (!url.protocol.startsWith("http") || !url.hostname) {
            return undefined;
        }
        return url.toString();
    } catch {
        return undefined;
    }
}

export function absoluteUrl(baseUrl: string, maybeRelative: string | undefined): string | undefined {
    if (!maybeRelative) {
        return undefined;
    }
    const cleaned = maybeRelative.trim();
    if (!cleaned) {
        return undefined;
    }
    if (/^https?:\/\//i.test(cleaned)) {
        return safeUrl(cleaned);
    }
    try {
        return new URL(cleaned, baseUrl).toString();
    } catch {
        return undefined;
    }
}

export function asInt(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const text = value.trim().replace(/,/g, "");
    if (!text) {
        return undefined;
    }
    const suffixMatch = text.match(/^(\d+(?:\.\d+)?)([kKmMbB])?$/);
    if (!suffixMatch) {
        const plain = Number.parseInt(text, 10);
        return Number.isFinite(plain) ? plain : undefined;
    }
    const base = Number.parseFloat(suffixMatch[1] ?? "");
    if (!Number.isFinite(base)) {
        return undefined;
    }
    const suffix = suffixMatch[2]?.toLowerCase();
    const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
    return Math.trunc(base * multiplier);
}

export function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
    for (const value of values) {
        if (value !== undefined && value !== null) {
            return value;
        }
    }
    return undefined;
}

export function collapseCaption(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const normalized = normalizeWhitespace(decodeHtmlEntities(stripTags(value)));
    return normalized || undefined;
}

export function titleFromCaption(caption: string | undefined, fallback?: string): string | undefined {
    const text = caption ?? fallback;
    if (!text) {
        return undefined;
    }
    return text.length > 96 ? text.slice(0, 96) : text;
}
