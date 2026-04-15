export class TokenStore {
    readonly #tokens = new Map<string, { cacheKey: string, expiresAt: number }>()

    constructor(private readonly ttlMs: number) {}

    set(token: string, cacheKey: string) {
        this.#tokens.set(token, { cacheKey, expiresAt: Date.now() + this.ttlMs })
    }

    get(token: string) {
        const entry = this.#tokens.get(token)
        if (!entry)
            return null
        if (entry.expiresAt <= Date.now()) {
            this.#tokens.delete(token)
            return null
        }
        return entry.cacheKey
    }

    cleanup() {
        const now = Date.now()
        for (const [token, entry] of this.#tokens) {
            if (entry.expiresAt <= now)
                this.#tokens.delete(token)
        }
    }
}
