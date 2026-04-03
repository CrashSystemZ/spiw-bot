# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SPIW-bot is a Telegram inline bot that resolves social media links (TikTok, Instagram, X/Twitter, Threads) into cached Telegram media. Python 3.13+, async-first with aiogram 3.x.

## Commands

```bash
# Install (editable)
pip install -e .

# Run
python -m spiw
# or
spiw-bot

# Docker
docker build -t spiw-bot:latest .
docker-compose up -d
```

No test suite or linter is configured.

## Required Environment

All config uses `SPIW_` prefix. Two required variables:
- `SPIW_BOT_TOKEN` - Telegram bot token
- `SPIW_SERVICE_CHAT_ID` - Chat/channel ID used to upload media and extract `file_id` for inline responses

Runtime requires `ffmpeg` and `ffprobe` on PATH (installed automatically in Docker).

## Architecture

### Request Flow

```
Inline Query → LinkValidator (extract + normalize URL)
  → MediaOrchestrator (check cache → resolve → prepare → deliver → cache)
    → Provider.resolve()        — platform-specific metadata extraction
    → MediaPipeline.prepare()   — download via yt-dlp + convert via ffmpeg
    → DeliveryService.upload()  — upload to Telegram service chat, get file_id
    → MediaCacheRepository.put() — persist to SQLite
  → InlineResults → user
```

### Key Layers

- **`spiw/links/`** - URL validation, platform-specific normalizers, redirect resolution. Each platform has a `LinkNormalizer` (Protocol) that extracts a canonical media ID.
- **`spiw/providers/`** - Platform adapters implementing `MediaProvider` (Protocol). Each returns `ResolvedAsset` with media metadata. `YtDlpProviderBase` is the shared base for yt-dlp-based providers. TikTok also uses HTML parsing and tikwm.com fallback API. Instagram uses `instaloader`. X uses fxtwitter.com API.
- **`spiw/pipeline/`** - Downloads media (`YtDlpDownloader` or direct HTTP), converts formats (`FFmpegToolkit`), returns `PreparedAsset` with files on disk.
- **`spiw/telegram/`** - Aiogram handlers for inline queries, chosen results, and callback queries. `MediaOrchestrator` coordinates the full lifecycle. `DeliveryService` uploads to Telegram and extracts `file_id`.
- **`spiw/storage/`** - `MediaCacheRepository` (SQLite via aiosqlite) for persistent cache. `InMemoryState` holds per-key async locks, TTL caches for provider results, carousel state, and debounce/retry tracking.
- **`spiw/models/`** - Data progression: `ResolvedAsset` (raw metadata) → `PreparedAsset` (files on disk) → `CachedMedia` (Telegram file_ids). Enums: `Platform`, `MediaKind`, `JobStatus`.

### Design Patterns

- **Lock-based deduplication**: Per-cache_key `asyncio.Lock` prevents duplicate processing of the same media.
- **Semaphore-bounded concurrency**: `processing_semaphore` limits parallel media processing jobs.
- **Two-phase inline response**: Initial query returns a loading placeholder + spawns background `_warmup_media()` task. When user selects the result, `handle_chosen_inline_result` waits for processing and edits the message.
- **Carousel via callbacks**: Multi-item posts use prev/next callback buttons with carousel state in TTL cache.
- **Provider fallback chains**: Providers try primary method first (e.g., yt-dlp), fall back to alternatives (e.g., tikwm API for TikTok).

### Entry Point

`spiw/__main__.py:main()` - Initializes settings, database (SQLite WAL mode), all services, registers handlers, starts aiogram polling. Cleanup task runs every 600s.
