import {createHash} from "node:crypto"

export function sha256(text: string) {
    return createHash("sha256").update(text).digest("hex")
}

export function md5(text: string) {
    return createHash("md5").update(text).digest("hex")
}

export function makeCacheKey(source: string) {
    return sha256(source)
}

export function canonicalizeInlineQuery(rawQuery: string) {
    const candidate = rawQuery.trim()
    if (!candidate)
        return ""

    try {
        const parsed = new URL(candidate)
        const path = parsed.pathname !== "/" && parsed.pathname.endsWith("/")
            ? parsed.pathname.replace(/\/+$/, "")
            : parsed.pathname
        const authority = parsed.port ? `${parsed.hostname.toLowerCase()}:${parsed.port}` : parsed.hostname.toLowerCase()
        return `${parsed.protocol.toLowerCase()}//${authority}${path}${parsed.search}`
    } catch {
        return candidate
    }
}

export function buildInlineQueryAliases(...queries: string[]) {
    const values = new Set<string>()

    for (const query of queries) {
        const trimmed = query.trim()
        if (!trimmed)
            continue
        values.add(canonicalizeInlineQuery(trimmed))
    }

    return [...values].filter(Boolean)
}
