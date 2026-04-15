import type {SessionEntry} from "./models.js"

export class SessionStore {
    readonly #entries = new Map<string, SessionEntry>()
    #bytesUsed = 0

    constructor(
        private readonly budgetBytes: number,
        private readonly defaultTtlMs: number,
    ) {
    }

    get(cacheKey: string) {
        const entry = this.#entries.get(cacheKey)
        if (!entry)
            return null
        if (entry.expiresAt <= Date.now()) {
            this.delete(cacheKey)
            return null
        }
        this.#entries.delete(cacheKey)
        this.#entries.set(cacheKey, entry)
        return entry
    }

    set(entry: Omit<SessionEntry, "expiresAt"> & { expiresAt?: number }) {
        const materialized: SessionEntry = {
            ...entry,
            expiresAt: entry.expiresAt ?? (Date.now() + this.defaultTtlMs),
        }

        if (this.#entries.has(materialized.cacheKey))
            this.delete(materialized.cacheKey)

        this.#entries.set(materialized.cacheKey, materialized)
        this.#bytesUsed += materialized.sizeBytes
        this.cleanup()
    }

    updateMetadata(cacheKey: string, metadata: SessionEntry["metadata"]) {
        const entry = this.#entries.get(cacheKey)
        if (!entry)
            return null
        entry.metadata = metadata
        this.#entries.delete(cacheKey)
        this.#entries.set(cacheKey, entry)
        return entry
    }

    delete(cacheKey: string) {
        const entry = this.#entries.get(cacheKey)
        if (!entry)
            return
        this.#entries.delete(cacheKey)
        this.#bytesUsed -= entry.sizeBytes
        if (this.#bytesUsed < 0)
            this.#bytesUsed = 0
    }

    cleanup() {
        const now = Date.now()
        for (const [key, entry] of this.#entries) {
            if (entry.expiresAt <= now)
                this.delete(key)
        }

        while (this.#bytesUsed > this.budgetBytes) {
            const oldestKey = this.#entries.keys().next().value as string | undefined
            if (!oldestKey)
                break
            this.delete(oldestKey)
        }
    }
}
