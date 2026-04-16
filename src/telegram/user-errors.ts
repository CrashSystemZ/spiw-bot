import {
    InternalInvariantError,
    MediaTooLargeError,
    MediaUnavailableError,
    UnsupportedLinkError,
} from "../core/errors.js"
import {messages} from "../core/messages.js"

export function renderUserError(error: unknown): string {
    if (error instanceof UnsupportedLinkError)
        return messages.unsupportedLink
    if (error instanceof MediaTooLargeError)
        return messages.mediaTooLarge
    if (error instanceof MediaUnavailableError) {
        if (error.reason === "local_processing")
            return messages.localProcessingUnsupported
        return messages.mediaUnavailable
    }
    if (error instanceof InternalInvariantError)
        return messages.tryAgain
    return messages.tryAgain
}
