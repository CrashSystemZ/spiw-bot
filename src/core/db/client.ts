import {mkdirSync} from "node:fs"
import {dirname} from "node:path"

import Database from "better-sqlite3"
import {drizzle, type BetterSQLite3Database} from "drizzle-orm/better-sqlite3"

import {dbSchema, initStatements} from "./schema.js"

export class DatabaseClient {
    readonly #connection: Database.Database
    readonly orm: BetterSQLite3Database<typeof dbSchema>

    private constructor(connection: Database.Database) {
        this.#connection = connection
        this.orm = drizzle(connection, {schema: dbSchema})
    }

    static create(dbPath: string): DatabaseClient {
        mkdirSync(dirname(dbPath), {recursive: true})
        const connection = new Database(dbPath)
        connection.pragma("journal_mode = WAL")
        connection.pragma("synchronous = NORMAL")
        connection.pragma("busy_timeout = 5000")
        connection.exec(initStatements)
        return new DatabaseClient(connection)
    }

    async close() {
        this.#connection.close()
    }
}
