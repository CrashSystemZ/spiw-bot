import {mkdirSync} from "node:fs"
import {dirname} from "node:path"
import {isMainThread, parentPort, workerData} from "node:worker_threads"

import Database from "better-sqlite3"

import type {CachedMetadataRecord, CachedRehydrateRecord, DeliveryStats, UiStateRecord,} from "../models.js"

if (isMainThread)
    throw new Error("db worker cannot run on the main thread")

if (!parentPort)
    throw new Error("db worker requires a parent port")

type RequestMessage = {
    id: number
    method: string
    payload: any
}

const dbPath = workerData.dbPath as string
mkdirSync(dirname(dbPath), {recursive: true})

const db = new Database(dbPath)
db.pragma("journal_mode = WAL")
db.pragma("synchronous = NORMAL")
db.pragma("busy_timeout = 5000")

const initStatements = `
    CREATE TABLE IF NOT EXISTS request_cache
    (
        id
        TEXT
        PRIMARY
        KEY,
        author_id
        INTEGER
        NOT
        NULL,
        raw_query
        TEXT
        NOT
        NULL,
        cache_key
        TEXT
        NOT
        NULL,
        normalized_url
        TEXT
        NOT
        NULL,
        source_url
        TEXT
        NOT
        NULL,
        created_at
        INTEGER
        NOT
        NULL
    );

    CREATE TABLE IF NOT EXISTS query_aliases
    (
        alias
        TEXT
        PRIMARY
        KEY,
        cache_key
        TEXT
        NOT
        NULL,
        created_at
        INTEGER
        NOT
        NULL
    );

    CREATE TABLE IF NOT EXISTS metadata_cache
    (
        cache_key
        TEXT
        PRIMARY
        KEY,
        value_json
        TEXT
        NOT
        NULL,
        created_at
        INTEGER
        NOT
        NULL
    );

    CREATE TABLE IF NOT EXISTS rehydrate_cache
    (
        cache_key
        TEXT
        PRIMARY
        KEY,
        value_json
        TEXT
        NOT
        NULL,
        created_at
        INTEGER
        NOT
        NULL
    );

    CREATE TABLE IF NOT EXISTS ui_state
    (
        token
        TEXT
        PRIMARY
        KEY,
        cache_key
        TEXT
        NOT
        NULL,
        caption_visible
        INTEGER
        NOT
        NULL,
        mode
        TEXT
        NOT
        NULL,
        item_index
        INTEGER
        NOT
        NULL,
        created_at
        INTEGER
        NOT
        NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_events
    (
        id
        INTEGER
        PRIMARY
        KEY
        AUTOINCREMENT,
        media_kind
        TEXT
        NOT
        NULL,
        delivered_at
        INTEGER
        NOT
        NULL
    );

    CREATE INDEX IF NOT EXISTS idx_request_cache_created ON request_cache(created_at);
    CREATE INDEX IF NOT EXISTS idx_query_aliases_cache_key ON query_aliases(cache_key);
    CREATE INDEX IF NOT EXISTS idx_metadata_cache_created ON metadata_cache(created_at);
    CREATE INDEX IF NOT EXISTS idx_rehydrate_cache_created ON rehydrate_cache(created_at);
    CREATE INDEX IF NOT EXISTS idx_ui_state_created ON ui_state(created_at);
    CREATE INDEX IF NOT EXISTS idx_ui_state_cache_key ON ui_state(cache_key);
    CREATE INDEX IF NOT EXISTS idx_delivery_events_delivered_at ON delivery_events(delivered_at);
`

db.exec(initStatements)

const statements = {
    putRequest: db.prepare(`
        INSERT
        OR REPLACE INTO request_cache
        (id, author_id, raw_query, cache_key, normalized_url, source_url, created_at)
        VALUES (@id, @authorId, @rawQuery, @cacheKey, @normalizedUrl, @sourceUrl, @createdAt)
    `),
    getRequest: db.prepare(`
        SELECT id,
               author_id      as authorId,
               raw_query      as rawQuery,
               cache_key      as cacheKey,
               normalized_url as normalizedUrl,
               source_url     as sourceUrl,
               created_at     as createdAt
        FROM request_cache
        WHERE id = ?
    `),
    deleteRequest: db.prepare(`DELETE
                               FROM request_cache
                               WHERE id = ?`),
    cleanupRequests: db.prepare(`DELETE
                                 FROM request_cache
                                 WHERE created_at < ?`),
    putAlias: db.prepare(`
        INSERT
        OR REPLACE INTO query_aliases (alias, cache_key, created_at)
        VALUES (?, ?, ?)
    `),
    getCacheKeyByAlias: db.prepare(`SELECT cache_key
                                    FROM query_aliases
                                    WHERE alias = ?`),
    cleanupAliases: db.prepare(`DELETE
                                FROM query_aliases
                                WHERE created_at < ?`),
    putMetadata: db.prepare(`
        INSERT
        OR REPLACE INTO metadata_cache (cache_key, value_json, created_at)
        VALUES (@cacheKey, @valueJson, @createdAt)
    `),
    getMetadata: db.prepare(`
        SELECT cache_key as cacheKey, value_json as valueJson, created_at as createdAt
        FROM metadata_cache
        WHERE cache_key = ?
    `),
    cleanupMetadata: db.prepare(`DELETE
                                 FROM metadata_cache
                                 WHERE created_at < ?`),
    putRehydrate: db.prepare(`
        INSERT
        OR REPLACE INTO rehydrate_cache (cache_key, value_json, created_at)
        VALUES (@cacheKey, @valueJson, @createdAt)
    `),
    getRehydrate: db.prepare(`
        SELECT cache_key as cacheKey, value_json as valueJson, created_at as createdAt
        FROM rehydrate_cache
        WHERE cache_key = ?
    `),
    cleanupRehydrate: db.prepare(`DELETE
                                  FROM rehydrate_cache
                                  WHERE created_at < ?`),
    putUiState: db.prepare(`
        INSERT
        OR REPLACE INTO ui_state
        (token, cache_key, caption_visible, mode, item_index, created_at)
        VALUES (@token, @cacheKey, @captionVisible, @mode, @itemIndex, @createdAt)
    `),
    getUiState: db.prepare(`
        SELECT token,
               cache_key       as cacheKey,
               caption_visible as captionVisible,
               mode,
               item_index      as itemIndex,
               created_at      as createdAt
        FROM ui_state
        WHERE token = ?
    `),
    deleteUiState: db.prepare(`DELETE
                               FROM ui_state
                               WHERE token = ?`),
    cleanupUiState: db.prepare(`DELETE
                                FROM ui_state
                                WHERE created_at < ?`),
    recordDelivery: db.prepare(`
        INSERT INTO delivery_events (media_kind, delivered_at)
        VALUES (?, ?)
    `),
    countSince: db.prepare(`
        SELECT COUNT(*) as count
        FROM delivery_events
        WHERE delivered_at >= ?
          AND media_kind IN ('video'
            , 'animation')
    `),
    countAll: db.prepare(`
        SELECT COUNT(*) as count
        FROM delivery_events
        WHERE media_kind IN ('video', 'animation')
    `),
}

parentPort.on("message", (message: RequestMessage) => {
    try {
        switch (message.method) {
            case "init":
                respond(message.id, true, null)
                return
            case "putRequest":
                statements.putRequest.run(message.payload)
                respond(message.id, true, null)
                return
            case "getRequest":
                respond(message.id, true, statements.getRequest.get(message.payload.id) ?? null)
                return
            case "deleteRequest":
                statements.deleteRequest.run(message.payload.id)
                respond(message.id, true, null)
                return
            case "cleanupRequests":
                statements.cleanupRequests.run(message.payload.beforeTs)
                respond(message.id, true, null)
                return
            case "putAliases": {
                const now = Date.now()
                const transaction = db.transaction((cacheKey: string, aliases: string[]) => {
                    for (const alias of aliases)
                        statements.putAlias.run(alias, cacheKey, now)
                })
                transaction(message.payload.cacheKey, message.payload.aliases)
                respond(message.id, true, null)
                return
            }
            case "getCacheKeyByAlias": {
                const row = statements.getCacheKeyByAlias.get(message.payload.alias) as {
                    cache_key: string
                } | undefined
                respond(message.id, true, row?.cache_key ?? null)
                return
            }
            case "cleanupAliases":
                statements.cleanupAliases.run(message.payload.beforeTs)
                respond(message.id, true, null)
                return
            case "putMetadata": {
                const record = message.payload as CachedMetadataRecord
                statements.putMetadata.run({
                    cacheKey: record.cacheKey,
                    valueJson: JSON.stringify(record.value),
                    createdAt: record.createdAt,
                })
                respond(message.id, true, null)
                return
            }
            case "getMetadata": {
                const row = statements.getMetadata.get(message.payload.cacheKey) as {
                    cacheKey: string
                    valueJson: string
                    createdAt: number
                } | undefined
                if (!row) {
                    respond(message.id, true, null)
                    return
                }
                respond(message.id, true, {
                    cacheKey: row.cacheKey,
                    createdAt: row.createdAt,
                    value: JSON.parse(row.valueJson),
                } satisfies CachedMetadataRecord)
                return
            }
            case "cleanupMetadata":
                statements.cleanupMetadata.run(message.payload.beforeTs)
                respond(message.id, true, null)
                return
            case "putRehydrate": {
                const record = message.payload as CachedRehydrateRecord
                statements.putRehydrate.run({
                    cacheKey: record.cacheKey,
                    valueJson: JSON.stringify(record.value),
                    createdAt: record.createdAt,
                })
                respond(message.id, true, null)
                return
            }
            case "getRehydrate": {
                const row = statements.getRehydrate.get(message.payload.cacheKey) as {
                    cacheKey: string
                    valueJson: string
                    createdAt: number
                } | undefined
                if (!row) {
                    respond(message.id, true, null)
                    return
                }
                respond(message.id, true, {
                    cacheKey: row.cacheKey,
                    createdAt: row.createdAt,
                    value: JSON.parse(row.valueJson),
                } satisfies CachedRehydrateRecord)
                return
            }
            case "cleanupRehydrate":
                statements.cleanupRehydrate.run(message.payload.beforeTs)
                respond(message.id, true, null)
                return
            case "putUiState": {
                const record = message.payload as UiStateRecord
                statements.putUiState.run({
                    token: record.token,
                    cacheKey: record.cacheKey,
                    captionVisible: record.captionVisible ? 1 : 0,
                    mode: record.mode,
                    itemIndex: record.index,
                    createdAt: record.createdAt,
                })
                respond(message.id, true, null)
                return
            }
            case "getUiState": {
                const row = statements.getUiState.get(message.payload.token) as {
                    token: string
                    cacheKey: string
                    captionVisible: number
                    mode: UiStateRecord["mode"]
                    itemIndex: number
                    createdAt: number
                } | undefined
                if (!row) {
                    respond(message.id, true, null)
                    return
                }
                respond(message.id, true, {
                    token: row.token,
                    cacheKey: row.cacheKey,
                    captionVisible: Boolean(row.captionVisible),
                    mode: row.mode,
                    index: row.itemIndex,
                    createdAt: row.createdAt,
                } satisfies UiStateRecord)
                return
            }
            case "deleteUiState":
                statements.deleteUiState.run(message.payload.token)
                respond(message.id, true, null)
                return
            case "cleanupUiState":
                statements.cleanupUiState.run(message.payload.beforeTs)
                respond(message.id, true, null)
                return
            case "recordDelivery":
                statements.recordDelivery.run(message.payload.kind, message.payload.deliveredAt)
                respond(message.id, true, null)
                return
            case "getStats": {
                const now = Number(message.payload.now)
                const since = now - (24 * 60 * 60 * 1000)
                const stats: DeliveryStats = {
                    last24Hours: Number((statements.countSince.get(since) as { count: number }).count ?? 0),
                    allTime: Number((statements.countAll.get() as { count: number }).count ?? 0),
                }
                respond(message.id, true, stats)
                return
            }
            default:
                respond(message.id, false, null, `Unknown db method: ${message.method}`)
        }
    } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error)
        respond(message.id, false, null, messageText)
    }
})

function respond(id: number, ok: boolean, result: unknown, error?: string) {
    parentPort!.postMessage({
        id,
        ok,
        result,
        error,
    })
}
