import {eq, lt} from "drizzle-orm"

import { DatabaseClient } from "../../core/db/client.js"
import { requestCache } from "../../core/db/schema.js"
import type { PendingRequestRecord } from "../../core/models.js"

export class RequestRepository {
    readonly #db: DatabaseClient["orm"]

    constructor(db: DatabaseClient) {
        this.#db = db.orm
    }

    put(request: PendingRequestRecord) {
        this.#db.insert(requestCache).values(request).onConflictDoUpdate({
            target: requestCache.id,
            set: {
                authorId: request.authorId,
                rawQuery: request.rawQuery,
                cacheKey: request.cacheKey,
                normalizedUrl: request.normalizedUrl,
                sourceUrl: request.sourceUrl,
                createdAt: request.createdAt,
            },
        }).run()
    }

    get(id: string) {
        return this.#db.select({
            id: requestCache.id,
            authorId: requestCache.authorId,
            rawQuery: requestCache.rawQuery,
            cacheKey: requestCache.cacheKey,
            normalizedUrl: requestCache.normalizedUrl,
            sourceUrl: requestCache.sourceUrl,
            createdAt: requestCache.createdAt,
        }).from(requestCache).where(eq(requestCache.id, id)).get() ?? null
    }

    delete(id: string) {
        this.#db.delete(requestCache).where(eq(requestCache.id, id)).run()
    }

    cleanupExpired(beforeTs: number) {
        this.#db.delete(requestCache).where(lt(requestCache.createdAt, beforeTs)).run()
    }
}
