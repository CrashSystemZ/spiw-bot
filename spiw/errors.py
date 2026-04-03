class BotError(Exception):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


class ValidationError(BotError):
    def __init__(self, message: str = "Link not supported") -> None:
        super().__init__("UNSUPPORTED_LINK", message)


class MediaUnavailableError(BotError):
    def __init__(self, message: str = "Failed to get media") -> None:
        super().__init__("MEDIA_UNAVAILABLE", message)


class DurationLimitError(BotError):
    def __init__(self, limit_seconds: int) -> None:
        super().__init__("MEDIA_TOO_LONG", f"Only videos up to {limit_seconds // 60} minutes are allowed")


class DeliveryError(BotError):
    def __init__(self, message: str = "Delivery failed") -> None:
        super().__init__("DELIVERY_FAILED", message)


class RateLimitError(BotError):
    def __init__(self, retry_after: int) -> None:
        self.retry_after = retry_after
        super().__init__("RATE_LIMITED", f"Rate limited, retry after {retry_after}s")
