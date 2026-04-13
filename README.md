# SPIW-bot

<p align="center">
  <img src="https://img.shields.io/badge/python-3.13-blue.svg" alt="Python" />
  <img src="https://img.shields.io/badge/aiogram-3.x-2ea44f.svg" alt="Aiogram" />
  <img src="https://img.shields.io/badge/yt--dlp-%E2%9A%A1-blueviolet.svg" alt="yt-dlp" />
  <img src="https://img.shields.io/badge/ffmpeg-required-4b5563.svg" alt="FFmpeg" />
</p>

**SPIW-bot** is a Telegram inline bot for resolving and delivering social media content as cached Telegram media. It validates links, fetches metadata, prepares and normalizes assets, caches results, and returns Telegram-ready inline items.

<img width="128" height="77" alt="Screenshot 2026-04-13 at 16 03 39 1" src="https://github.com/user-attachments/assets/b36f1fb5-d011-4a18-bf18-32af47660e22" />

<img width="285" height="124" alt="Screenshot 2026-04-13 at 16 04 30 1" src="https://github.com/user-attachments/assets/43d00511-cf86-45d5-9046-5f0df3c8d1fb" />

<img width="128" height="185" alt="Screenshot 2026-04-13 at 16 05 38 1" src="https://github.com/user-attachments/assets/ebdc7b76-a062-4290-b485-71175d012d9d" />

## What it does

- Supports Telegram inline queries with links from major platforms.
- Handles posts, reels, stories, and multi-item galleries where supported.
- Uses SQLite caching for instant repeated responses.
- Normalizes and deduplicates input links.
- Converts media into Telegram-friendly formats: jpg, png, mp4.
- Applies concurrency and duration limits to reduce overload.
- Designed for secure containerized deployment.

## Supported platforms

- TikTok
- Instagram
- X / Twitter
- Threads

## Architecture overview

- `spiw.__main__` initializes settings, database, cache, and starts polling.
- `spiw.telegram` handles inline handlers, result rendering, and callbacks.
- `spiw.orchestrator` coordinates the full lifecycle: resolve -> prepare -> upload -> cache.
- `spiw.providers.*` extracts media metadata for each platform.
- `spiw.pipeline` downloads and normalizes content using `yt-dlp` and `ffmpeg`.
- `spiw.storage` manages cache persistence and in-memory processing state.

## Requirements

- Python **3.13+**
- `ffmpeg` and `ffprobe` (if running outside Docker)
- Telegram bot token

## Quick start (local)

1) Prepare environment

```bash
cp .env.example .env
```

Set variables in `.env`:

```env
SPIW_BOT_TOKEN=YOUR_BOT_TOKEN
SPIW_SERVICE_CHAT_ID=-1001234567890
```

`SPIW_SERVICE_CHAT_ID` is the chat/channel used to upload media and reuse Telegram `file_id` values in inline responses.

2) Install and run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
spiw-bot
```

Alternative:

```bash
python -m spiw
```

## Docker

### Build and run

```bash
docker build -t spiw-bot:latest .
docker-compose up -d
```

`docker-compose.yml` mounts:

- `/tmp/spiw-media` as `tmpfs` for temporary conversion files.
- `./data:/app/data` as persistent SQLite cache storage.

### Environment for container

Required variables:

- `SPIW_BOT_TOKEN`
- `SPIW_SERVICE_CHAT_ID`

Example:

```bash
SPIW_BOT_TOKEN=...
SPIW_SERVICE_CHAT_ID=...
docker-compose up -d
```

### Deploy script

`deploy.sh` contains a manual deploy flow: build image, save archive, transfer, load and restart container.

## Configuration

All config is driven by `SPIW_` prefixed environment variables.

| Parameter | Default | Description |
|---|---:|---|
| `SPIW_BOT_TOKEN` | required | Telegram bot token |
| `SPIW_SERVICE_CHAT_ID` | required | Chat ID used for caching uploads |
| `SPIW_MAX_VIDEO_DURATION_SECONDS` | `600` | Maximum allowed video duration |
| `SPIW_PROCESSING_CONCURRENCY` | `8` | Parallel jobs in processing stage |
| `SPIW_DIRECT_DOWNLOAD_CONCURRENCY` | `6` | Parallel direct download threads |
| `SPIW_MAX_MEDIA_GROUP_ITEMS` | `10` | Maximum items in Telegram media groups |
| `SPIW_INLINE_CACHE_SECONDS` | `900` | Inline cache TTL |
| `SPIW_INLINE_RESOLVE_TIMEOUT` | `5.0` | Metadata warm-up timeout for inline query |
| `SPIW_PROVIDER_TIMEOUT_SECONDS` | `45.0` | Provider request timeout |
| `SPIW_HTTP_TIMEOUT_SECONDS` | `15.0` | HTTP request timeout |
| `SPIW_DB_PATH` | `data/spiw.db` | SQLite cache path |
| `SPIW_MEDIA_TEMP_DIR` | `/tmp/spiw-media` | Working directory for temporary files |
| `SPIW_FFMPEG_BINARY` | `ffmpeg` | ffmpeg binary path |
| `SPIW_FFPROBE_BINARY` | `ffprobe` | ffprobe binary path |
| `SPIW_TIKTOK_FALLBACK_API_URL` | `https://www.tikwm.com/api/` | TikTok fallback endpoint |

## Supported URL formats

- TikTok: `tiktok.com/t/<id>`, `tiktok.com/video/...`, `vm.tiktok.com/...`, `vt.tiktok.com/...`
- Instagram: `instagram.com/reel/<id>`, `instagram.com/p/<id>`
- X / Twitter: `x.com/<handle>/status/<id>` or `twitter.com/<handle>/status/<id>`
- Threads: `threads.com/@<user>/post/<id>`

Links can be provided inside a text message; the bot extracts the first valid URL.

## Data and files

- `spiw.db` stores cached media metadata and query aliases.
- `data/` keeps persistent cache state when used with Docker.
- `.env.example` contains the baseline environment template.
- `Dockerfile` and `docker-compose.yml` define container runtime.

## How to use in Telegram

1) Add the bot as an inline bot.
2) In any chat, send `@YourBotName <link>`.
3) For simple media, results are sent immediately.
4) For complex content, a loading placeholder appears, then final media is delivered.

## Troubleshooting

- Bot does not respond: check link format and platform support.
- Processing errors: check logs for timeouts or upstream provider changes.
- ffmpeg-related errors: ensure binaries exist and paths in `SPIW_FFMPEG_BINARY` / `SPIW_FFPROBE_BINARY` are valid.

## Development

```bash
pip install -e .
python -m spiw
```
