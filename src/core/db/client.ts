import {Worker} from "node:worker_threads"

import type {
    CachedMetadataRecord,
    CachedRehydrateRecord,
    DeliveryStats,
    PendingRequestRecord,
    UiStateRecord,
} from "../models.js"

type WorkerMethod =
    | "init"
    | "putRequest"
    | "getRequest"
    | "deleteRequest"
    | "cleanupRequests"
    | "putAliases"
    | "getCacheKeyByAlias"
    | "cleanupAliases"
    | "putMetadata"
    | "getMetadata"
    | "cleanupMetadata"
    | "putRehydrate"
    | "getRehydrate"
    | "cleanupRehydrate"
    | "putUiState"
    | "getUiState"
    | "deleteUiState"
    | "cleanupUiState"
    | "recordDelivery"
    | "getStats"

type WorkerRequest = {
    id: number
    method: WorkerMethod
    payload: unknown
}

type WorkerResponse = {
    id: number
    ok: boolean
    result?: unknown
    error?: string
}

export class DatabaseClient {
    readonly #worker: Worker
    readonly #pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
    #seq = 0

    constructor(dbPath: string) {
        this.#worker = new Worker(resolveWorkerUrl(), {
            execArgv: process.execArgv,
            workerData: {dbPath},
        })

        this.#worker.on("message", (message: WorkerResponse) => {
            const pending = this.#pending.get(message.id)
            if (!pending)
                return
            this.#pending.delete(message.id)
            if (message.ok) {
                pending.resolve(message.result)
                return
            }
            pending.reject(new Error(message.error ?? "Unknown database worker error"))
        })

        this.#worker.on("error", (error) => {
            for (const pending of this.#pending.values())
                pending.reject(error instanceof Error ? error : new Error(String(error)))
            this.#pending.clear()
        })
    }

    async init() {
        await this.#call("init", null)
    }

    async close() {
        await this.#worker.terminate()
    }

    putRequest(request: PendingRequestRecord) {
        return this.#call("putRequest", request)
    }

    getRequest(id: string) {
        return this.#call("getRequest", {id}) as Promise<PendingRequestRecord | null>
    }

    deleteRequest(id: string) {
        return this.#call("deleteRequest", {id})
    }

    cleanupRequests(beforeTs: number) {
        return this.#call("cleanupRequests", {beforeTs})
    }

    putAliases(cacheKey: string, aliases: string[]) {
        return this.#call("putAliases", {cacheKey, aliases})
    }

    getCacheKeyByAlias(alias: string) {
        return this.#call("getCacheKeyByAlias", {alias}) as Promise<string | null>
    }

    cleanupAliases(beforeTs: number) {
        return this.#call("cleanupAliases", {beforeTs})
    }

    putMetadata(record: CachedMetadataRecord) {
        return this.#call("putMetadata", record)
    }

    getMetadata(cacheKey: string) {
        return this.#call("getMetadata", {cacheKey}) as Promise<CachedMetadataRecord | null>
    }

    cleanupMetadata(beforeTs: number) {
        return this.#call("cleanupMetadata", {beforeTs})
    }

    putRehydrate(record: CachedRehydrateRecord) {
        return this.#call("putRehydrate", record)
    }

    getRehydrate(cacheKey: string) {
        return this.#call("getRehydrate", {cacheKey}) as Promise<CachedRehydrateRecord | null>
    }

    cleanupRehydrate(beforeTs: number) {
        return this.#call("cleanupRehydrate", {beforeTs})
    }

    putUiState(record: UiStateRecord) {
        return this.#call("putUiState", record)
    }

    getUiState(token: string) {
        return this.#call("getUiState", {token}) as Promise<UiStateRecord | null>
    }

    deleteUiState(token: string) {
        return this.#call("deleteUiState", {token})
    }

    cleanupUiState(beforeTs: number) {
        return this.#call("cleanupUiState", {beforeTs})
    }

    recordDelivery(kind: "video" | "animation", deliveredAt: number) {
        return this.#call("recordDelivery", {kind, deliveredAt})
    }

    getStats(now: number) {
        return this.#call("getStats", {now}) as Promise<DeliveryStats>
    }

    #call(method: WorkerMethod, payload: unknown) {
        const id = ++this.#seq
        const request: WorkerRequest = {id, method, payload}
        return new Promise<unknown>((resolve, reject) => {
            this.#pending.set(id, {resolve, reject})
            this.#worker.postMessage(request)
        })
    }
}

function resolveWorkerUrl() {
    return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url)
}
