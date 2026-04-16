import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const requestCache = sqliteTable("request_cache", {
    id: text("id").primaryKey(),
    authorId: integer("author_id").notNull(),
    rawQuery: text("raw_query").notNull(),
    cacheKey: text("cache_key").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    sourceUrl: text("source_url").notNull(),
    createdAt: integer("created_at").notNull(),
}, table => ({
    createdAtIdx: index("idx_request_cache_created").on(table.createdAt),
}))

export const queryAliases = sqliteTable("query_aliases", {
    alias: text("alias").primaryKey(),
    cacheKey: text("cache_key").notNull(),
    createdAt: integer("created_at").notNull(),
}, table => ({
    cacheKeyIdx: index("idx_query_aliases_cache_key").on(table.cacheKey),
}))

export const metadataCache = sqliteTable("metadata_cache", {
    cacheKey: text("cache_key").primaryKey(),
    valueJson: text("value_json").notNull(),
    createdAt: integer("created_at").notNull(),
}, table => ({
    createdAtIdx: index("idx_metadata_cache_created").on(table.createdAt),
}))

export const rehydrateCache = sqliteTable("rehydrate_cache", {
    cacheKey: text("cache_key").primaryKey(),
    valueJson: text("value_json").notNull(),
    createdAt: integer("created_at").notNull(),
}, table => ({
    createdAtIdx: index("idx_rehydrate_cache_created").on(table.createdAt),
}))

export const uiState = sqliteTable("ui_state", {
    token: text("token").primaryKey(),
    cacheKey: text("cache_key").notNull(),
    captionVisible: integer("caption_visible").notNull(),
    mode: text("mode", { enum: ["media", "audio"] }).notNull(),
    itemIndex: integer("item_index").notNull(),
    createdAt: integer("created_at").notNull(),
}, table => ({
    createdAtIdx: index("idx_ui_state_created").on(table.createdAt),
    cacheKeyIdx: index("idx_ui_state_cache_key").on(table.cacheKey),
}))

export const deliveryEvents = sqliteTable("delivery_events", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mediaKind: text("media_kind", { enum: ["video", "animation"] }).notNull(),
    deliveredAt: integer("delivered_at").notNull(),
}, table => ({
    deliveredAtIdx: index("idx_delivery_events_delivered_at").on(table.deliveredAt),
}))

export const dbSchema = {
    requestCache,
    queryAliases,
    metadataCache,
    rehydrateCache,
    uiState,
    deliveryEvents,
} as const

export const initStatements = `
    CREATE TABLE IF NOT EXISTS request_cache (
        id TEXT PRIMARY KEY,
        author_id INTEGER NOT NULL,
        raw_query TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        source_url TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS query_aliases (
        alias TEXT PRIMARY KEY,
        cache_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata_cache (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rehydrate_cache (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ui_state (
        token TEXT PRIMARY KEY,
        cache_key TEXT NOT NULL,
        caption_visible INTEGER NOT NULL,
        mode TEXT NOT NULL,
        item_index INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_kind TEXT NOT NULL,
        delivered_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_request_cache_created ON request_cache(created_at);
    CREATE INDEX IF NOT EXISTS idx_query_aliases_cache_key ON query_aliases(cache_key);
    CREATE INDEX IF NOT EXISTS idx_metadata_cache_created ON metadata_cache(created_at);
    CREATE INDEX IF NOT EXISTS idx_rehydrate_cache_created ON rehydrate_cache(created_at);
    CREATE INDEX IF NOT EXISTS idx_ui_state_created ON ui_state(created_at);
    CREATE INDEX IF NOT EXISTS idx_ui_state_cache_key ON ui_state(cache_key);
    CREATE INDEX IF NOT EXISTS idx_delivery_events_delivered_at ON delivery_events(delivered_at);
`
