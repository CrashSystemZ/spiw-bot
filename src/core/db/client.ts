import {mkdirSync} from "node:fs"
import {dirname} from "node:path"

import Database from "better-sqlite3"
import {drizzle, type BetterSQLite3Database} from "drizzle-orm/better-sqlite3"

import {dbSchema} from "./schema.js"

export class DatabaseClient {
    readonly connection: Database.Database
    readonly orm: BetterSQLite3Database<typeof dbSchema>

    constructor(dbPath: string) {
        mkdirSync(dirname(dbPath), {recursive: true})

        this.connection = new Database(dbPath)
        this.connection.pragma("journal_mode = WAL")
        this.connection.pragma("synchronous = NORMAL")
        this.connection.pragma("busy_timeout = 5000")
        this.connection.exec(initStatements)
        this.orm = drizzle(this.connection, {schema: dbSchema})
    }

    async init() {
    }

    async close() {
        this.connection.close()
    }
}

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
