import {and, gte, inArray, sql} from "drizzle-orm"

import { DatabaseClient } from "../../core/db/client.js"
import {deliveryEvents} from "../../core/db/schema.js"
import type {DeliveryStats} from "../../core/models.js"

export class StatsRepository {
    readonly #db: DatabaseClient["orm"]

    constructor(db: DatabaseClient) {
        this.#db = db.orm
    }

    recordDelivery(kind: "video" | "animation", deliveredAt: number) {
        this.#db.insert(deliveryEvents).values({
            mediaKind: kind,
            deliveredAt,
        }).run()
    }

    getStats(now: number): DeliveryStats {
        const since = now - (24 * 60 * 60 * 1000)
        const deliveredKinds = ["video", "animation"] as const
        const last24Hours = this.#db.select({
            count: sql<number>`count(*)`,
        }).from(deliveryEvents).where(and(
            gte(deliveryEvents.deliveredAt, since),
            inArray(deliveryEvents.mediaKind, deliveredKinds),
        )).get()?.count ?? 0
        const allTime = this.#db.select({
            count: sql<number>`count(*)`,
        }).from(deliveryEvents).where(inArray(deliveryEvents.mediaKind, deliveredKinds)).get()?.count ?? 0
        return {
            last24Hours: Number(last24Hours ?? 0),
            allTime: Number(allTime ?? 0),
        }
    }
}
