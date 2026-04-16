export type MediaUnavailableReason =
    | "not_found"
    | "expired"
    | "cobalt_failed"
    | "protocol"
    | "local_processing"

export abstract class DomainError extends Error {
    protected constructor(message: string) {
        super(message)
        this.name = new.target.name
    }
}

export class UnsupportedLinkError extends DomainError {
    constructor() {
        super("Link not supported")
    }
}

export class MediaUnavailableError extends DomainError {
    readonly reason: MediaUnavailableReason
    readonly cobaltCode?: string
    readonly httpStatus?: number

    constructor(
        reason: MediaUnavailableReason,
        context?: {cobaltCode?: string; httpStatus?: number},
    ) {
        super(`Media unavailable (${reason}${context?.cobaltCode ? `: ${context.cobaltCode}` : ""})`)
        this.reason = reason
        if (context?.cobaltCode)
            this.cobaltCode = context.cobaltCode
        if (context?.httpStatus !== undefined)
            this.httpStatus = context.httpStatus
    }
}

export class MediaTooLargeError extends DomainError {
    constructor() {
        super("Media too large")
    }
}

export class InternalInvariantError extends DomainError {
    constructor(message: string) {
        super(`Internal invariant: ${message}`)
    }
}
