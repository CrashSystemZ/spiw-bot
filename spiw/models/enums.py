from enum import StrEnum


class Platform(StrEnum):
    TIKTOK = "tiktok"
    INSTAGRAM = "instagram"
    X = "x"
    THREADS = "threads"


class MediaKind(StrEnum):
    VIDEO = "video"
    PHOTO = "photo"
    ANIMATION = "animation"


class JobStatus(StrEnum):
    RESOLVING = "resolving"
    PREPARING = "preparing"
    READY = "ready"
    FAILED = "failed"
