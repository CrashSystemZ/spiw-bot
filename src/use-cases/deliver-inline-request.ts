import {messages} from "../core/messages.js"
import type {PendingRequestRecord, ResolvedMetadata, SessionEntry} from "../core/models.js"
import {isCaptionAvailable, shouldShowCaptionByDefault} from "../core/caption-policy.js"
import {SpiwRuntime} from "../core/runtime.js"

export type InitialMessageState = {
    metadata: ResolvedMetadata
    captionVisible: boolean
}

export type DeliveredInlineRequest = {
    request: PendingRequestRecord
    session: SessionEntry
    initialMessage: InitialMessageState
}

export async function deliverInlineRequest(
    runtime: SpiwRuntime,
    requestId: string,
): Promise<DeliveredInlineRequest> {
    const delivered = await runtime.hydrateSessionForRequest(requestId)
    if (!delivered.session.items.length)
        throw new Error(messages.mediaUnavailable)

    return {
        ...delivered,
        initialMessage: await resolveInitialMessageState(runtime, delivered.session),
    }
}

export async function retryInlineDelivery(
    runtime: SpiwRuntime,
    cacheKey: string,
) {
    const session = await runtime.hydrateSessionFromCacheKey(cacheKey)
    return {
        session,
        initialMessage: await resolveInitialMessageState(runtime, session),
    }
}

async function resolveInitialMessageState(runtime: SpiwRuntime, session: SessionEntry): Promise<InitialMessageState> {
    let metadata = session.metadata

    if (shouldShowCaptionByDefault(metadata.platform) && !isCaptionAvailable(metadata)) {
        const pretty = await runtime.ensurePrettyMetadata(session.cacheKey)
        if (pretty)
            metadata = pretty
    }

    return {
        metadata,
        captionVisible: shouldShowCaptionByDefault(metadata.platform) && isCaptionAvailable(metadata),
    }
}
