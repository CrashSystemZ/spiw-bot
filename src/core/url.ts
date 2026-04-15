const urlPattern = /https?:\/\/\S+/i

export function tryParseUrl(input: string) {
    const trimmed = input.trim()
    if (!trimmed)
        return null

    const candidate = trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed.split(/\s+/, 1)[0]!
        : (trimmed.match(urlPattern)?.[0] ?? trimmed.split(/\s+/, 1)[0]!)

    const normalized = candidate.replace(/[.,;!?)>\]]+$/, "")
    try {
        const parsed = new URL(normalized)
        if (parsed.protocol === "http:")
            parsed.protocol = "https:"
        return parsed.toString()
    } catch {
        const domain = normalized.split("/")[0] ?? ""
        if (!domain.includes(".") || /[\s:]/.test(domain))
            return null
        try {
            return new URL(`https://${normalized}`).toString()
        } catch {
            return null
        }
    }
}
