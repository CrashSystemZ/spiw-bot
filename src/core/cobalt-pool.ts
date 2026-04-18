import {logInfo, logWarn} from "./log.js"

export type CobaltEndpoint = {
    name: string
    url: string
    authorization?: string
}

type DiscoveryConfig = {
    url: string
    services: string[]
    max: number
    refreshMs: number
    requestTimeoutMs: number
}

const EXCLUDED_HOST_SUFFIXES = [
    "imput.net",
    "api.cobalt.tools",
]

export class CobaltPool {
    readonly #static: readonly CobaltEndpoint[]
    readonly #discovery: DiscoveryConfig | null
    #dynamic: readonly CobaltEndpoint[] = []
    #bannedHosts = new Set<string>()
    #refreshTimer: NodeJS.Timeout | null = null
    #started = false

    constructor(staticEndpoints: readonly CobaltEndpoint[], discovery: DiscoveryConfig | null) {
        this.#static = staticEndpoints
        this.#discovery = discovery
    }

    endpoints(): readonly CobaltEndpoint[] {
        return [
            ...this.#static,
            ...this.#dynamic.filter(e => !this.#bannedHosts.has(hostOf(e.url))),
        ]
    }

    /**
     * Помечаем endpoint как "не пробовать до следующего refresh'а".
     * Вызывается из CobaltClient когда endpoint вернул auth/turnstile ошибку —
     * эти проблемы не transient, retry бесполезен.
     */
    banEndpoint(url: string, reason: string) {
        const host = hostOf(url)
        if (!host || this.#bannedHosts.has(host))
            return
        this.#bannedHosts.add(host)
        logWarn("cobalt.pool.endpoint_banned", {host, reason})
    }

    async start() {
        if (this.#started)
            return
        this.#started = true
        logInfo("cobalt.pool.started", {
            staticCount: this.#static.length,
            discoveryEnabled: this.#discovery !== null,
            services: this.#discovery?.services ?? null,
        })
        if (!this.#discovery)
            return
        await this.refresh()
        this.#refreshTimer = setInterval(() => {
            void this.refresh()
        }, this.#discovery.refreshMs)
        this.#refreshTimer.unref()
    }

    dispose() {
        if (this.#refreshTimer) {
            clearInterval(this.#refreshTimer)
            this.#refreshTimer = null
        }
    }

    async refresh() {
        if (!this.#discovery)
            return
        const {url, services, max, requestTimeoutMs} = this.#discovery
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs)
        try {
            const response = await fetch(url, {signal: controller.signal})
            if (!response.ok) {
                logWarn("cobalt.pool.refresh_http_error", {status: response.status})
                return
            }
            const body = await response.json() as {data?: Record<string, unknown>}
            const data = body.data
            if (!data || typeof data !== "object") {
                logWarn("cobalt.pool.refresh_invalid_body", {})
                return
            }

            const seen = new Set(this.#static.map(e => normalizeHost(e.url)))
            const merged: CobaltEndpoint[] = []
            for (const service of services) {
                const urls = data[service]
                if (!Array.isArray(urls))
                    continue
                for (const raw of urls) {
                    if (typeof raw !== "string")
                        continue
                    const host = normalizeHost(raw)
                    if (!host || seen.has(host))
                        continue
                    if (isExcludedHost(raw))
                        continue
                    seen.add(host)
                    merged.push({name: host, url: raw})
                    if (merged.length >= max)
                        break
                }
                if (merged.length >= max)
                    break
            }

            this.#dynamic = merged
            this.#bannedHosts = new Set()
            logInfo("cobalt.pool.refreshed", {
                staticCount: this.#static.length,
                dynamicCount: merged.length,
                endpoints: merged.map(e => e.name),
            })
        } catch (error) {
            logWarn("cobalt.pool.refresh_failed", {
                error: error instanceof Error ? error.message : String(error),
            })
        } finally {
            clearTimeout(timeoutId)
        }
    }
}

function normalizeHost(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl)
        return `${parsed.protocol}//${parsed.host}`
    } catch {
        return ""
    }
}

function hostOf(rawUrl: string): string {
    try {
        return new URL(rawUrl).host.toLowerCase()
    } catch {
        return ""
    }
}

function isExcludedHost(rawUrl: string): boolean {
    const host = hostOf(rawUrl)
    if (!host)
        return true
    return EXCLUDED_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))
}
