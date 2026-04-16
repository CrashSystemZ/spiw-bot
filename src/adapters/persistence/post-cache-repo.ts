import {eq, lt} from "drizzle-orm"

import { buildInlineQueryAliases } from "../../core/hash.js"
import { DatabaseClient } from "../../core/db/client.js"
import { metadataCache, queryAliases, rehydrateCache } from "../../core/db/schema.js"
import type { CachedRecord, ResolvedMetadata } from "../../core/models.js"
import { isExpired } from "../../core/time.js"

export class PostCacheRepository {
    readonly #db: DatabaseClient["orm"]

    constructor(db: DatabaseClient) {
        this.#db = db.orm
    }

    findFreshRehydrate(rawQuery: string, parsedUrl: string, ttlSeconds: number) {
        const aliases = buildInlineQueryAliases(rawQuery, parsedUrl)
        for (const alias of aliases) {
            const cacheKey = this.getCacheKeyByAlias(alias)
            if (!cacheKey)
                continue

            const cached = this.getRehydrateRecord(cacheKey)
            if (!cached)
                continue

            if (isExpired(cached.createdAt, ttlSeconds))
                continue

            return {
                alias,
                cacheKey,
                metadata: cached.value,
            }
        }

        return null
    }

    putRehydrate(record: CachedRecord) {
        this.#db.insert(rehydrateCache).values({
            cacheKey: record.cacheKey,
            valueJson: JSON.stringify(record.value),
            createdAt: record.createdAt,
        }).onConflictDoUpdate({
            target: rehydrateCache.cacheKey,
            set: {
                valueJson: JSON.stringify(record.value),
                createdAt: record.createdAt,
            },
        }).run()
    }

    getFreshRehydrate(cacheKey: string, ttlSeconds: number) {
        const cached = this.getRehydrateRecord(cacheKey)
        if (!cached || isExpired(cached.createdAt, ttlSeconds))
            return null
        return cached.value
    }

    putPretty(record: CachedRecord) {
        this.#db.insert(metadataCache).values({
            cacheKey: record.cacheKey,
            valueJson: JSON.stringify(record.value),
            createdAt: record.createdAt,
        }).onConflictDoUpdate({
            target: metadataCache.cacheKey,
            set: {
                valueJson: JSON.stringify(record.value),
                createdAt: record.createdAt,
            },
        }).run()
    }

    getFreshPretty(cacheKey: string, ttlSeconds: number) {
        const cached = this.getMetadataRecord(cacheKey)
        if (!cached || isExpired(cached.createdAt, ttlSeconds))
            return null
        return cached.value
    }

    saveRehydrateWithAliases(metadata: ResolvedMetadata, rawQuery: string, parsedUrl: string, createdAt: number) {
        const aliases = Array.from(new Set(buildInlineQueryAliases(rawQuery, parsedUrl, metadata.normalizedUrl, metadata.sourceUrl)))
        const aliasCreatedAt = createdAt
        this.#db.transaction((tx) => {
            tx.insert(rehydrateCache).values({
                cacheKey: metadata.cacheKey,
                valueJson: JSON.stringify(metadata),
                createdAt,
            }).onConflictDoUpdate({
                target: rehydrateCache.cacheKey,
                set: {
                    valueJson: JSON.stringify(metadata),
                    createdAt,
                },
            }).run()

            if (aliases.length > 0) {
                tx.insert(queryAliases).values(aliases.map(alias => ({
                    alias,
                    cacheKey: metadata.cacheKey,
                    createdAt: aliasCreatedAt,
                }))).onConflictDoUpdate({
                    target: queryAliases.alias,
                    set: {
                        cacheKey: metadata.cacheKey,
                        createdAt: aliasCreatedAt,
                    },
                }).run()
            }
        })
    }

    cleanupAliases(beforeTs: number) {
        this.#db.delete(queryAliases).where(lt(queryAliases.createdAt, beforeTs)).run()
    }

    cleanupRehydrate(beforeTs: number) {
        this.#db.delete(rehydrateCache).where(lt(rehydrateCache.createdAt, beforeTs)).run()
    }

    cleanupPretty(beforeTs: number) {
        this.#db.delete(metadataCache).where(lt(metadataCache.createdAt, beforeTs)).run()
    }

    private getCacheKeyByAlias(alias: string): string | null {
        return this.#db.select({
            cacheKey: queryAliases.cacheKey,
        }).from(queryAliases).where(eq(queryAliases.alias, alias)).get()?.cacheKey ?? null
    }

    private getMetadataRecord(cacheKey: string): CachedRecord | null {
        const row = this.#db.select({
            cacheKey: metadataCache.cacheKey,
            valueJson: metadataCache.valueJson,
            createdAt: metadataCache.createdAt,
        }).from(metadataCache).where(eq(metadataCache.cacheKey, cacheKey)).get()
        if (!row)
            return null
        return {
            cacheKey: row.cacheKey,
            createdAt: row.createdAt,
            value: JSON.parse(row.valueJson),
        }
    }

    private getRehydrateRecord(cacheKey: string): CachedRecord | null {
        const row = this.#db.select({
            cacheKey: rehydrateCache.cacheKey,
            valueJson: rehydrateCache.valueJson,
            createdAt: rehydrateCache.createdAt,
        }).from(rehydrateCache).where(eq(rehydrateCache.cacheKey, cacheKey)).get()
        if (!row)
            return null
        return {
            cacheKey: row.cacheKey,
            createdAt: row.createdAt,
            value: JSON.parse(row.valueJson),
        }
    }
}
