import {DEFAULT_USER_AGENT} from "./shared.js";
import {MetadataFetchOptions} from "../types/metadata.js";
import {MetadataUnavailableError} from "./errors.js";
import {logError, logInfo, logWarn} from "../log.js";

export interface FetchedHtml {
    url: string;
    html: string;
    status: number;
}

function makeTimeoutSignal(timeoutMs: number | undefined): { signal?: AbortSignal; cleanup: () => void } {
    if (!timeoutMs || timeoutMs <= 0) {
        return {cleanup: () => undefined};
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
    };
}

export async function fetchHtml(url: string, options: MetadataFetchOptions = {}): Promise<FetchedHtml> {
    const {signal, cleanup} = makeTimeoutSignal(options.timeoutMs);
    logInfo("metadata.fetch_html.start", {
        url,
        timeoutMs: options.timeoutMs ?? null,
        hasCustomHeaders: Boolean(options.headers && Object.keys(options.headers).length),
    })
    try {
        const response = await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal,
            headers: {
                "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                ...options.headers,
            },
        });

        if (!response.ok) {
            logWarn("metadata.fetch_html.http_error", {
                url,
                status: response.status,
                finalUrl: response.url || url,
            })
            throw new MetadataUnavailableError(`The page responded with status ${response.status}`);
        }

        const html = await response.text()
        logInfo("metadata.fetch_html.ok", {
            url,
            finalUrl: response.url || url,
            status: response.status,
            htmlLength: html.length,
        })
        return {
            url: response.url || url,
            html,
            status: response.status,
        };
    } catch (error) {
        if (error instanceof MetadataUnavailableError) {
            throw error;
        }
        logError("metadata.fetch_html.failed", error, {url})
        throw new MetadataUnavailableError("Failed to load the page");
    } finally {
        cleanup();
    }
}

export async function followRedirect(url: string, options: MetadataFetchOptions = {}): Promise<string> {
    const {signal, cleanup} = makeTimeoutSignal(options.timeoutMs);
    logInfo("metadata.follow_redirect.start", {
        url,
        timeoutMs: options.timeoutMs ?? null,
        hasCustomHeaders: Boolean(options.headers && Object.keys(options.headers).length),
    });
    try {
        const response = await fetch(url, {
            method: "HEAD",
            redirect: "follow",
            signal,
            headers: {
                "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
                ...options.headers,
            },
        });
        if (response.url) {
            logInfo("metadata.follow_redirect.ok", {
                url,
                finalUrl: response.url,
                status: response.status,
                method: "HEAD",
            });
            return response.url;
        }
    } catch (error) {
        logWarn("metadata.follow_redirect.head_failed", {
            url,
            reason: error instanceof Error ? error.message : String(error),
        });
    } finally {
        cleanup();
    }

    logInfo("metadata.follow_redirect.fallback_fetch_html", {url});
    const fetched = await fetchHtml(url, options);
    return fetched.url;
}
