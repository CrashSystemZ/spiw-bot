export class MetadataError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "MetadataError";
        this.code = code;
    }
}

export class UnsupportedUrlError extends MetadataError {
    constructor(message = "The URL is not supported") {
        super("UNSUPPORTED_URL", message);
        this.name = "UnsupportedUrlError";
    }
}

export class MetadataUnavailableError extends MetadataError {
    constructor(message = "Failed to resolve metadata") {
        super("METADATA_UNAVAILABLE", message);
        this.name = "MetadataUnavailableError";
    }
}

export class MetadataParseError extends MetadataError {
    constructor(message = "Failed to parse the page") {
        super("METADATA_PARSE_ERROR", message);
        this.name = "MetadataParseError";
    }
}
