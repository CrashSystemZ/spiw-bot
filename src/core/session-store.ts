import {LRUCache} from "lru-cache"

import type {SessionEntry} from "./models.js"

export class SessionStore {
    readonly #entries: LRUCache<string, SessionEntry>

    constructor(
        budgetBytes: number,
        private readonly defaultTtlMs: number,
    ) {
        this.#entries = new LRUCache<string, SessionEntry>({
            maxSize: budgetBytes,
            sizeCalculation: (entry) => entry.sizeBytes,
            ttl: defaultTtlMs,
            updateAgeOnGet: true,
        })
    }

    get(cacheKey: string) {
        return this.#entries.get(cacheKey) ?? null
    }

    set(entry: Omit<SessionEntry, "expiresAt"> & { expiresAt?: number }) {
        const expiresAt = entry.expiresAt ?? (Date.now() + this.defaultTtlMs)
        const materialized: SessionEntry = {
            ...entry,
            expiresAt,
        }
        this.#entries.set(materialized.cacheKey, materialized, {
            ttl: Math.max(0, expiresAt - Date.now()),
        })
    }

    updateMetadata(cacheKey: string, metadata: SessionEntry["metadata"]) {
        const entry = this.#entries.get(cacheKey)
        if (!entry)
            return null

        const updated: SessionEntry = {
            ...entry,
            metadata,
        }
        this.#entries.set(cacheKey, updated, {
            ttl: Math.max(0, updated.expiresAt - Date.now()),
        })
        return updated
    }

    cleanup() {
        this.#entries.purgeStale()
    }
}
