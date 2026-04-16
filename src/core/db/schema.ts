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
