import {eq, lt} from "drizzle-orm"

import { DatabaseClient } from "../../core/db/client.js"
import { uiState } from "../../core/db/schema.js"
import type { UiStateRecord } from "../../core/models.js"
import { isExpired } from "../../core/time.js"

export class UiStateRepository {
    readonly #db: DatabaseClient["orm"]

    constructor(db: DatabaseClient) {
        this.#db = db.orm
    }

    put(record: UiStateRecord) {
        this.#db.insert(uiState).values({
            token: record.token,
            cacheKey: record.cacheKey,
            captionVisible: record.captionVisible ? 1 : 0,
            mode: record.mode,
            itemIndex: record.index,
            createdAt: record.createdAt,
        }).onConflictDoUpdate({
            target: uiState.token,
            set: {
                cacheKey: record.cacheKey,
                captionVisible: record.captionVisible ? 1 : 0,
                mode: record.mode,
                itemIndex: record.index,
                createdAt: record.createdAt,
            },
        }).run()
    }

    getFresh(token: string, ttlSeconds: number) {
        const row = this.#db.select({
            token: uiState.token,
            cacheKey: uiState.cacheKey,
            captionVisible: uiState.captionVisible,
            mode: uiState.mode,
            itemIndex: uiState.itemIndex,
            createdAt: uiState.createdAt,
        }).from(uiState).where(eq(uiState.token, token)).get()
        const state = row ? {
            token: row.token,
            cacheKey: row.cacheKey,
            captionVisible: Boolean(row.captionVisible),
            mode: row.mode,
            index: row.itemIndex,
            createdAt: row.createdAt,
        } satisfies UiStateRecord : null
        if (!state)
            return null
        if (isExpired(state.createdAt, ttlSeconds)) {
            this.#db.delete(uiState).where(eq(uiState.token, token)).run()
            return null
        }
        return state
    }

    delete(token: string) {
        this.#db.delete(uiState).where(eq(uiState.token, token)).run()
    }

    cleanupExpired(beforeTs: number) {
        this.#db.delete(uiState).where(lt(uiState.createdAt, beforeTs)).run()
    }
}
