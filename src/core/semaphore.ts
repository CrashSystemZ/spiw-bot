export class Semaphore {
    readonly #waiters: Array<() => void> = []
    #value: number

    constructor(value: number) {
        this.#value = value
    }

    async acquire() {
        if (this.#value > 0) {
            this.#value -= 1
            return
        }

        await new Promise<void>((resolve) => {
            this.#waiters.push(resolve)
        })
    }

    release() {
        const next = this.#waiters.shift()
        if (next) {
            next()
            return
        }
        this.#value += 1
    }

    async use<T>(fn: () => Promise<T>) {
        await this.acquire()
        try {
            return await fn()
        } finally {
            this.release()
        }
    }
}
