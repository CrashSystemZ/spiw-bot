# CLAUDE.md

## Project identity

**spiw-bot** v2.0.0 — Telegram inline bot that resolves social media links (TikTok, Instagram, X/Twitter, Threads) and delivers them as cached Telegram media. Users type `@BotName <link>` in any chat and receive the media instantly (or after a short processing delay).

Language: Python 3.13+. Fully async (asyncio). No tests exist yet.

## Quick reference

```bash
# Run locally
pip install -e .
spiw-bot          # or: python -m spiw

# Docker
docker build -t spiw-bot:latest .
docker-compose up -d

# Deploy to remote server
./deploy.sh
```

Required env vars (prefix `SPIW_`):
- `SPIW_BOT_TOKEN` — Telegram bot token (from @BotFather)
- `SPIW_SERVICE_CHAT_ID` — Telegram chat/channel ID used to upload media and reuse `file_id` values

Runtime deps outside Python: `ffmpeg`, `ffprobe` (installed via apt in Docker).

## Directory structure

```
spiw-bot-py/
├── spiw/                           # Main package
│   ├── __main__.py                 # Entry point — wires everything, starts polling
│   ├── bot.py                      # Creates aiogram Bot + Dispatcher
│   ├── config.py                   # Pydantic Settings (all SPIW_* env vars)
│   ├── errors.py                   # Exception hierarchy (BotError and subclasses)
│   ├── models/                     # Dataclasses and enums
│   │   ├── enums.py                # Platform, MediaKind, JobStatus (all StrEnum)
│   │   ├── media.py                # Resolved → Prepared → Cached media models
│   │   ├── inline.py               # InlineSession, CarouselState
│   │   └── validated_url.py        # NormalizedLink, ValidatedUrl
│   ├── links/                      # URL validation and normalization
│   │   ├── validator.py            # LinkValidator: extract URL → normalize → cache key
│   │   ├── normalizers.py          # Per-platform normalizers (TikTok, Instagram, X, Threads)
│   │   └── redirect.py             # HTTP redirect resolver (vm.tiktok.com → www.tiktok.com)
│   ├── providers/                  # Platform-specific media extractors
│   │   ├── base.py                 # MediaProvider protocol
│   │   ├── yt_dlp_base.py          # Base class for yt-dlp based providers
│   │   ├── tiktok.py               # TikTok (yt-dlp + HTML scraping + tikwm API fallback)
│   │   ├── instagram.py            # Instagram (instaloader for /p/, yt-dlp for /reels/)
│   │   ├── x.py                    # X/Twitter (fxtwitter API + yt-dlp fallback)
│   │   └── threads.py              # Threads (HTML scraping + JSON extraction)
│   ├── pipeline/                   # Media download and normalization
│   │   ├── downloader.py           # YtDlpDownloader: fetches raw files
│   │   ├── ffmpeg.py               # FFmpegToolkit: probe, remux, convert, render
│   │   └── processor.py            # MediaPipeline: orchestrates download + normalization
│   ├── storage/                    # Persistence layer
│   │   ├── database.py             # SQLite init (WAL mode, tables, migrations)
│   │   ├── media_cache.py          # MediaCacheRepository: CRUD for cached media
│   │   └── memory.py               # InMemoryState: sessions, carousels, locks, semaphores
│   ├── telegram/                   # Telegram bot logic
│   │   ├── handlers.py             # Inline query, chosen result, callback handlers
│   │   ├── orchestrator.py         # MediaOrchestrator: full lifecycle coordinator
│   │   ├── delivery.py             # DeliveryService: uploads to service chat, extracts file_ids
│   │   └── inline_results.py       # Result builders, keyboard constructors, caption formatting
│   └── utils/
│       ├── hashing.py              # Cache keys, query aliases, carousel tokens
│       └── messages.py             # User-facing strings with emoji
├── pyproject.toml                  # Package metadata, dependencies, entry point
├── Dockerfile                      # python:3.13-slim + ffmpeg
├── docker-compose.yml              # Service def with tmpfs, read-only FS, security opts
├── deploy.sh                       # Build → tar → scp → load → restart
└── README.md                       # User-facing documentation
```

## Architecture

### High-level data flow

```
User sends: @spiw_bot https://tiktok.com/...
  │
  ▼
[InlineQuery handler]
  │
  ├─ LinkValidator.validate(raw_query)
  │    ├─ Extract URL from text (regex)
  │    ├─ Find normalizer by hostname
  │    ├─ Resolve redirects if short URL (vm.tiktok.com, tiktok.com/t/...)
  │    ├─ Normalize URL to canonical form
  │    └─ Generate cache_key = "{platform}:{sha256(seed)}"
  │
  ├─ Check SQLite cache (media_cache table + query_aliases table)
  │    ├─ HIT → return InlineQueryResult immediately
  │    └─ MISS → continue...
  │
  ├─ Try metadata warmup (5s timeout)
  │    └─ Provider.resolve(url, media_id) → ResolvedAsset (cached in memory 1h)
  │
  ├─ Return inline result to user:
  │    ├─ Simple uncached photo → InlineQueryResultPhoto (direct URL)
  │    └─ Everything else → InlineQueryResultArticle (loading placeholder)
  │
  ├─ Spawn async _warmup_media() task
  │
  ▼
[_warmup_media / _complete_inline]
  │
  ├─ MediaOrchestrator.process(validated_url)
  │    ├─ Check cache (with per-key lock to prevent duplicate work)
  │    ├─ Provider.resolve(url, media_id) → ResolvedAsset
  │    ├─ Check duration limit (default 600s / 10min)
  │    ├─ Acquire processing semaphore (max 8 concurrent)
  │    ├─ MediaPipeline.prepare(asset, workdir)
  │    │    ├─ Download: yt-dlp or direct HTTP (ThreadPoolExecutor, 6 workers)
  │    │    ├─ Normalize: photos→JPEG, animations→MP4, videos→MP4 (remux)
  │    │    └─ Special: single photo + audio → render h264 video
  │    ├─ DeliveryService.upload_and_cache(prepared)
  │    │    ├─ Upload to service_chat_id (send_video/photo/animation/audio)
  │    │    ├─ Extract Telegram file_ids
  │    │    └─ Retry logic: 5 attempts, rate-limit aware (parse "retry after N")
  │    └─ Store in SQLite + save query aliases
  │
  ▼
[User clicks result → ChosenInlineResult]
  │
  ├─ Wait for cache (poll every 0.25s, up to 60s)
  ├─ Edit inline message with actual media + keyboard
  └─ If carousel: show navigation buttons (prev/next/audio toggle)
```

### Component dependency graph

```
__main__.py
  ├── Settings (config.py)
  ├── init_database (storage/database.py) → aiosqlite
  ├── MediaCacheRepository (storage/media_cache.py) → aiosqlite
  ├── InMemoryState (storage/memory.py) → cachetools.TTLCache
  ├── Providers (providers/*.py) → yt-dlp, instaloader, aiohttp
  ├── FFmpegToolkit (pipeline/ffmpeg.py) → ffmpeg/ffprobe subprocesses
  ├── YtDlpDownloader (pipeline/downloader.py) → yt-dlp, aiohttp
  ├── MediaPipeline (pipeline/processor.py) → downloader + ffmpeg
  ├── DeliveryService (telegram/delivery.py) → aiogram Bot
  ├── MediaOrchestrator (telegram/orchestrator.py) → cache + providers + pipeline + delivery
  ├── LinkValidator (links/validator.py) → normalizers + redirect resolver
  └── HandlerDeps (telegram/handlers.py) → everything above
```

### Data model transformation chain

```
Raw query string
    ↓ LinkValidator.validate()
ValidatedUrl { original_url, normalized_url, platform, media_id, cache_key }
    ↓ Provider.resolve()
ResolvedAsset { platform, items: [ResolvedMediaItem], audio_track?, title, description, ... }
    ↓ MediaPipeline.prepare()
PreparedAsset { cache_key, platform, items: [PreparedMediaItem], audio_path?, ... }
    ↓ DeliveryService.upload_and_cache()
CachedMedia { cache_key, platform, items: [CachedMediaItem(file_id)], audio_file_id?, ... }
    ↓ stored in SQLite, used in inline results
```

## Enums

```python
Platform:  "tiktok" | "instagram" | "x" | "threads"   # StrEnum
MediaKind: "video"  | "photo"     | "animation"        # StrEnum
JobStatus: "resolving" | "preparing" | "ready" | "failed"  # StrEnum
```

## Provider details

### TikTok (`providers/tiktok.py`)
- **Video posts**: yt-dlp primary, tikwm API fallback (`https://www.tikwm.com/api/`)
- **Photo posts** (`/photo/` URLs): HTML scraping for `api-data` or `__UNIVERSAL_DATA_FOR_REHYDRATION__` script tags, tikwm fallback for images + audio
- **Stories**: detected via `story_type=1` query param; audio stories converted to photo + audio track
- **Live images**: merged as ANIMATION kind from tikwm `live_images` field
- **Audio extraction**: from music field (play_url.uri or play_url)
- **All photo posts**: `force_direct_download = True` (skip yt-dlp download, use direct HTTP)

### Instagram (`providers/instagram.py`)
- **/p/ (posts)**: `instaloader.Post.from_shortcode()` — handles single posts and carousels (sidecar edges)
- **/reels/**: yt-dlp fallback
- **Caption**: from `edge_media_to_caption` edges
- **Resolution**: picks highest from `display_resources[]`
- **All posts**: `force_direct_download = True`

### X/Twitter (`providers/x.py`)
- **Primary**: fxtwitter API (`https://api.fxtwitter.com/status/{tweet_id}`)
- **Fallback**: yt-dlp (enriched with title/description from fxtwitter)
- **Media types**: photos, videos (prefers h264 MP4 <=8Mbps), GIFs (as ANIMATION), mosaics, external media links
- **Description**: stripped of URLs, truncated to 900 chars

### Threads (`providers/threads.py`)
- **Scraping**: HTTP request with full Chromium User-Agent headers
- **JSON extraction**: parses `RelayPrefetchedStreamCache` script tag, finds post by shortcode
- **Post scoring**: ranks candidates by like_count + caption + carousel + video + image presence
- **Spoiler support**: checks `is_spoiler_media` / `is_covered_media` fields
- **Video variants**: priority by type (101 < 102 < 103), prefers highest

## Pipeline details

### Download (`pipeline/downloader.py`)
- **Direct download mode**: when `force_direct_download=True` OR all items are photos — uses `ThreadPoolExecutor(max_workers=6)` for parallel HTTP downloads
- **yt-dlp download mode**: for video content — format selector: `bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=1080]`, merge to MP4

### FFmpeg operations (`pipeline/ffmpeg.py`)
- `probe(path)` — ffprobe JSON output (streams + format)
- `remux_video(path)` — copy codec streams, add `faststart`, output .mp4
- `convert_image_to_jpeg(path)` — JPEG quality 2
- `render_photo_with_audio(image, audio, duration)` — loop image, encode h264 + aac video
- `convert_animation_to_mp4(path)` — GIF/WEBP → MP4 with yuv420p, pad to even dimensions

### Processing (`pipeline/processor.py`)
- Discovers media files in workdir (excludes `*.part`, `*.ytdl`, `*.json`, `*.meta`, etc.)
- Photo + audio → single h264 video (via `render_photo_with_audio`)
- Each file normalized: photo→JPEG, animation→MP4, video→MP4 (remux)
- Probes each result for width/height/duration

## Storage

### SQLite (`storage/database.py`)
- WAL mode, 5s busy timeout, NORMAL synchronous, 24MB cache
- **Tables**:
  - `media_cache` — PK: `cache_key`; columns: platform, items_json, title, description, thumbnail_url, source_url, like_count, comment_count, created_at, audio_file_id, audio_duration
  - `query_aliases` — PK: `alias_hash`; FK: `cache_key` → media_cache
- **Indexes**: `idx_query_aliases_cache_key`, `idx_media_cache_created`
- **Migrations**: audio_file_id and audio_duration columns added via ALTER TABLE if missing

### In-memory state (`storage/memory.py`)
- `provider_cache`: TTLCache(1000, 3600s) — caches ResolvedAsset to avoid re-resolving
- `inline_sessions`: dict — tracks in-progress inline query processing
- `carousel_sessions`: TTLCache(500, 259200s / 3 days) — carousel navigation state
- `warmup_debounce`: TTLCache(1000, 30s) — prevents duplicate warmup tasks
- `retry_state`: TTLCache(500, 300s) — retry button data
- `_locks`: dict of asyncio.Lock — per-cache_key to prevent duplicate processing
- `processing_semaphore`: asyncio.Semaphore — limits concurrent pipeline jobs (default 8)
- **Cleanup** (every 10min): removes sessions older than 1h, trims locks to 5000 max

## Telegram interaction model

### Update types handled
Only three: `inline_query`, `chosen_inline_result`, `callback_query`. No direct messages.

### Inline query flow
1. User types `@bot <link>` → `handle_inline_query`
2. Link validated + cache checked
3. If cached: instant result (with carousel keyboard if multi-item)
4. If not: 5s metadata warmup attempt, then return loading placeholder or direct photo
5. Async `_warmup_media` spawned to process in background

### Chosen inline result flow
1. User clicks a result → `handle_chosen_inline_result`
2. If result_id starts with `loading` or `failed` → spawn `_complete_inline`
3. Wait up to 60s for cache, then process if still missing
4. Edit inline message with actual media + keyboard

### Callback query routing
- `like` → heart emoji toast
- `noop:*` → no action (used for index display)
- `car:{token}:{index}` → navigate carousel
- `aud:{token}:{index}` → switch to audio view
- `pho:{token}:{index}` → switch back to photo from audio
- `retry:{key}` → reprocess a failed link

### Keyboards
- **Post keyboard**: [heart + count] [link emoji → source URL] [share emoji → switch_inline_query]
- **Carousel navigation**: [left arrow] [index/total] [right arrow] + optional [music note → audio]
- **Audio mode**: [photo emoji → return to photo] + main buttons

### Captions
- Only shown for X and Threads posts (have meaningful text content)
- MarkdownV2 escaped, truncated to 900 chars (hard limit 1024 with escaping)

## Error handling

### Exception hierarchy
```
BotError(code, message)           # base
├── ValidationError               # code: UNSUPPORTED_LINK
├── MediaUnavailableError         # code: MEDIA_UNAVAILABLE
├── DurationLimitError            # code: MEDIA_TOO_LONG
├── DeliveryError                 # code: DELIVERY_FAILED
└── RateLimitError(retry_after)   # code: RATE_LIMITED
```

### Delivery retry logic
- Up to 5 attempts per upload
- Parses "retry after N" from Telegram API exceptions
- Cooldown: 0.25s after success, additional padding after rate limit
- Falls back to individual uploads if media group fails

### Inline error recovery
- Failed processing → error message in inline message + retry button (via retry_state TTL cache)
- Carousel expired → toast message
- Warmup timeout → still processes async, user gets result on click

## Configuration reference

All env vars use `SPIW_` prefix (case-insensitive, managed by pydantic-settings):

| Variable | Type | Default | Description |
|---|---|---|---|
| `SPIW_BOT_TOKEN` | str | **required** | Telegram bot token |
| `SPIW_SERVICE_CHAT_ID` | int | **required** | Chat/channel for file_id caching uploads |
| `SPIW_MAX_VIDEO_DURATION_SECONDS` | int | 600 | Max video length (10 min) |
| `SPIW_PROCESSING_CONCURRENCY` | int | 8 | Max parallel pipeline jobs (semaphore) |
| `SPIW_DIRECT_DOWNLOAD_CONCURRENCY` | int | 6 | Threads for parallel direct downloads |
| `SPIW_MAX_MEDIA_GROUP_ITEMS` | int | 10 | Max items in Telegram media group |
| `SPIW_INLINE_CACHE_SECONDS` | int | 900 | Inline result cache TTL (15 min) |
| `SPIW_INLINE_RESOLVE_TIMEOUT` | float | 5.0 | Metadata warmup timeout per query |
| `SPIW_PROVIDER_TIMEOUT_SECONDS` | float | 45.0 | Provider HTTP request timeout |
| `SPIW_HTTP_TIMEOUT_SECONDS` | float | 15.0 | General HTTP request timeout |
| `SPIW_DB_PATH` | Path | `data/spiw.db` | SQLite database file path |
| `SPIW_MEDIA_TEMP_DIR` | Path | `/tmp/spiw-media` | Temporary workdir for media conversion |
| `SPIW_FFMPEG_BINARY` | str | `ffmpeg` | Path to ffmpeg executable |
| `SPIW_FFPROBE_BINARY` | str | `ffprobe` | Path to ffprobe executable |
| `SPIW_TIKTOK_FALLBACK_API_URL` | str | `https://www.tikwm.com/api/` | TikTok fallback endpoint |

## Dependencies

```
aiogram>=3.18,<4           # Telegram bot framework (async, aiogram 3.x)
aiosqlite>=0.20,<1         # Async SQLite driver
aiohttp>=3.11,<4           # Async HTTP client
yt-dlp[default]>=2025.1    # Universal media extractor
instaloader>=4.15,<5       # Instagram scraper (for /p/ posts)
cachetools>=5.5,<6         # TTLCache for in-memory caches
pydantic>=2.10,<3          # Data validation
pydantic-settings>=2.7,<3  # Env-based settings with SPIW_ prefix
```

Runtime binaries: `ffmpeg`, `ffprobe`, `curl` (Docker only).

## Supported URL patterns

| Platform | URL patterns | Normalizer host matches |
|---|---|---|
| TikTok | `tiktok.com/@user/video/{id}`, `tiktok.com/@user/photo/{id}`, `vm.tiktok.com/{code}`, `vt.tiktok.com/{code}`, `tiktok.com/t/{code}` | www/m/vm/vt.tiktok.com |
| Instagram | `instagram.com/p/{shortcode}`, `instagram.com/reel/{shortcode}` | instagram.com, www.instagram.com |
| X/Twitter | `x.com/{handle}/status/{id}`, `twitter.com/{handle}/status/{id}` | x.com, www.x.com, twitter.com, www.twitter.com |
| Threads | `threads.com/@{user}/post/{id}`, `threads.net/@{user}/post/{id}` | threads.com, www.threads.com, threads.net, www.threads.net |

Short URLs (vm.tiktok.com, tiktok.com/t/) are expanded via HTTP redirect resolution before normalization.

## Caching strategy

1. **Cache key**: `{platform}:{sha256(media_id_or_normalized_url)}`
2. **Query aliases**: multiple URL forms (with/without trailing slash, original/normalized) mapped to same cache_key via `query_aliases` table
3. **Lookup order**: direct cache_key → query alias scan
4. **In-memory provider cache**: ResolvedAsset stored for 1h (avoids re-resolving for same link)
5. **Telegram file_id reuse**: media uploaded once to service channel, file_id stored in SQLite for all future inline results

## Docker deployment

- Base image: `python:3.13-slim`
- Security: read-only filesystem, `no-new-privileges`, runs as uid 10001
- Volumes: `./data:/app/data` (persistent SQLite), `/tmp/spiw-media` as 2GB tmpfs
- `deploy.sh`: builds `linux/amd64`, saves tar, scp to server, docker load + restart

## Key design decisions

- **Inline-only bot**: no direct message handling. All interaction via inline queries + callbacks.
- **Service channel pattern**: media uploaded to a dedicated Telegram channel to obtain `file_id`s, which are then reused in inline results (avoids re-uploading).
- **Lock-based deduplication**: per-cache_key asyncio.Lock prevents multiple concurrent processes for the same link.
- **Semaphore throttling**: limits total concurrent pipeline jobs (default 8) to avoid resource exhaustion.
- **Warmup + complete pattern**: inline query triggers async warmup; if user clicks before ready, `_complete_inline` waits and retries.
- **Provider fallback chains**: each platform has primary + fallback extraction methods for resilience.
- **Direct download for photos**: bypasses yt-dlp download for photo carousels (faster, uses ThreadPoolExecutor).
- **TTL-based cleanup**: in-memory caches auto-expire (provider cache 1h, carousel 3 days, debounce 30s, retry 5min).

## Common modification patterns

### Adding a new platform
1. Add value to `Platform` enum in `models/enums.py`
2. Create normalizer in `links/normalizers.py` (implement `LinkNormalizer` protocol)
3. Register normalizer hosts in `create_normalizers()`
4. Create provider in `providers/` (implement `MediaProvider` protocol — `async def resolve(url, media_id) -> ResolvedAsset`)
5. Register provider in `__main__.py` providers dict

### Adding a new config option
1. Add field to `Settings` class in `config.py` (auto-picks up `SPIW_` prefixed env var)
2. Pass through from `__main__.py` to wherever needed

### Adding a new callback action
1. Add routing in `handle_callback_query()` in `handlers.py`
2. Create handler function `_handle_*()` following existing pattern
3. Add keyboard button in `inline_results.py`

### Modifying the cache schema
1. Add column via ALTER TABLE in `database.py` (follow existing audio_file_id pattern)
2. Update `MediaCacheRepository` get/put methods in `media_cache.py`
3. Update `CachedMedia` dataclass in `models/media.py`

## Logging

- Format: `%(asctime)s [%(levelname)s] %(name)s: %(message)s`
- Level: INFO
- Output: stdout
- Per-module loggers via `logging.getLogger(__name__)`
- Cache keys logged as first 16 chars for brevity

## Important conventions

- All dataclasses use `slots=True` for memory efficiency; frozen where immutable
- All enums are `StrEnum` for JSON serialization
- Captions only for X and Threads (platforms with meaningful text)
- MarkdownV2 escaping for all Telegram captions
- Module-level `_deps` global in handlers.py (set once at startup via `register_handlers`)
- Provider results must return `ResolvedAsset` with correct `force_direct_download` flag
- Workdirs created under `SPIW_MEDIA_TEMP_DIR` and cleaned up after processing
