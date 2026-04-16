<div align="center">

# spiw-bot

**Send social-media videos inline in any Telegram chat.**
No files on disk, no `ffmpeg`, no `yt-dlp` — just forward the link.

<p>
  <img src="https://img.shields.io/badge/Node.js-22-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node 22">
  <img src="https://img.shields.io/badge/TypeScript-6.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 6">
  <img src="https://img.shields.io/badge/SQLite-WAL-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Docker-compose-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="MIT">
</p>

</div>

---

## What it does

Type a social-media URL into Telegram's inline mode in **any chat** →
the bot replies with a playable inline card. Tap it — media is fetched
through a pool of [cobalt](https://github.com/imputnet/cobalt) servers
and the message becomes the actual video, photo carousel, or audio.

All media stays **in RAM**. Nothing is written to disk on the bot host.

## Supported platforms

<p>
  <img src="https://img.shields.io/badge/TikTok-000000?style=for-the-badge&logo=tiktok&logoColor=white" alt="TikTok">
  <img src="https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="Instagram">
  <img src="https://img.shields.io/badge/X%20(Twitter)-000000?style=for-the-badge&logo=x&logoColor=white" alt="X / Twitter">
  <img src="https://img.shields.io/badge/Threads-000000?style=for-the-badge&logo=threads&logoColor=white" alt="Threads">
</p>

Videos, photo carousels, GIFs, and audio tracks are all supported.
Carousel items have ⬅️ ➡️ navigation, a 🎵 toggle when there's a
separate audio track, and a 🔄 retry if delivery fails.

### Not supported (and why)

<p>
  <img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube (blocked)">
</p>

YouTube is explicitly blocked. Cobalt needs logged-in YouTube cookies
or a residential proxy to bypass bot-check, and we don't ship either.
Posting a `youtube.com` or `youtu.be` link returns
`Link not supported 😩` instead of silently failing.

Everything else that isn't in the list above (Reddit, Facebook, random
sites, etc.) gets the same rejection at parse time — no wasted cobalt
calls.

## How it works

```
 Telegram user
     │ inline query: https://tiktok.com/…
     ▼
 spiw-bot ──► metadata resolver (tiktok / instagram / x / threads)
     │
     │ on tap
     ▼
 Cobalt pool ──► self-hosted cobalt   (fast, private)
     │          ↳ if rate-limited, fall through to
     │             community instances from cobalt.directory
     ▼
 RAM buffers ──► Telegram edit-message
```

1. **Inline query** hits our resolver whitelist; unsupported URLs are
   rejected immediately.
2. **Tap** starts the real work: cobalt resolves the URL to a media
   tunnel, we stream the bytes into RAM (hard cap, default 2 GB), probe
   them with `mediainfo.js`, and edit the inline message to the actual
   media.
3. **Cobalt pool with fallback** — our primary instance is self-hosted.
   When TikTok/Instagram rate-limit our data-center IP, the bot
   auto-falls through to community cobalt instances discovered via
   [cobalt.directory](https://cobalt.directory/api/working). Endpoints
   that return `auth.jwt.missing` or HTTP 403 are auto-banned until the
   next hourly refresh.

## Why MTProto ⚡

<p>
  <img src="https://img.shields.io/badge/powered_by-MTProto-229ED9?style=for-the-badge&logo=telegram&logoColor=white" alt="MTProto">
</p>

Unlike 99% of Telegram bots this one does **not** use the HTTPS Bot API.
It talks native **MTProto** through [`mtcute`](https://mtcute.dev) — the
same protocol the official Telegram apps use. That matters:

- **Big files.** Bot API caps uploads at **50 MB**. MTProto lets us push
  up to **2 GB** per file (4 GB for Premium). No "file too large" when
  forwarding a 100 MB TikTok.
- **Faster inline.** Updates flow over a persistent MTProto connection,
  not long-polled HTTPS — inline cards appear and edit with minimum
  round-trip latency.
- **Direct data-center upload.** Media goes straight to Telegram's file
  DCs, bypassing the Bot API proxy layer entirely. Less copying, less
  bandwidth, less lag.
- **Full Telegram capability.** Features the Bot API exposes slowly or
  not at all (stable inline edits, large-file chunking, rich message
  operations) are available natively.

In short: it's not a toy wrapper — it's a real Telegram client that
happens to answer as a bot.

## Quick start

```bash
# 1. clone + install
git clone https://github.com/CrashSystemZ/spiw-bot
cd spiw-bot
npm install

# 2. configure
cp .env.example .env
# fill in BOT_TOKEN, TG_API_ID, TG_API_HASH

# 3. run
docker compose up -d
```

For local dev without Docker:
```bash
npm run dev   # tsx watch, hot-reload
```

## Configuration

The bot reads env via Zod; unset optional vars get sane defaults.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `BOT_TOKEN` | ✅ | — | Telegram bot token |
| `TG_API_ID` / `TG_API_HASH` | ✅ | — | MTProto app credentials |
| `COBALT_BASE_URL` | ✅ | — | Primary cobalt instance URL |
| `COBALT_DISCOVERY_ENABLED` | | `true` | Enable community fallback pool |
| `COBALT_DISCOVERY_SERVICES` | | `tiktok,instagram` | Which service categories to pick from cobalt.directory |
| `COBALT_DISCOVERY_MAX` | | `5` | Max dynamic endpoints to keep |
| `MEDIA_BUFFER_BUDGET_BYTES` | | `2 GB` | LRU session cache size |
| `MAX_CONCURRENT_JOBS` | | `32` | Parallel session builds |

All user-facing strings live in
[`resources/messages.json`](resources/messages.json) — edit them without
rebuilding.

## Architecture

```
src/
├── telegram/       mtcute dispatcher, handlers, UI builders
├── use-cases/      request-flow, session-flow, details-flow
├── core/           runtime, cobalt client & pool, errors, logger
│   ├── metadata/   platform resolvers (whitelist lives here)
│   └── db/         drizzle schema + SQLite client
└── adapters/       metadata gateway, media session builder, repos
```

**Layered, dependency-injected, testable.** `SpiwRuntime` is the DI
root; nothing reads globals except the validated `env` object.
## Tech stack

<p>
  <img src="https://img.shields.io/badge/Node.js_22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/TypeScript_6-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/mtcute-229ED9?style=flat-square&logo=telegram&logoColor=white" alt="mtcute">
  <img src="https://img.shields.io/badge/Drizzle_ORM-C5F74F?style=flat-square&logo=drizzle&logoColor=black" alt="Drizzle">
  <img src="https://img.shields.io/badge/better--sqlite3-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="better-sqlite3">
  <img src="https://img.shields.io/badge/Zod-3E67B1?style=flat-square&logo=zod&logoColor=white" alt="Zod">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/cobalt-EEEEEE?style=flat-square&logoColor=black" alt="cobalt">
</p>

- **MTProto:** [`mtcute`](https://mtcute.dev) — Telegram client+dispatcher
- **DB:** SQLite (WAL) + [`drizzle-orm`](https://orm.drizzle.team)
- **Media resolver:** [`cobalt`](https://github.com/imputnet/cobalt) with
  a dynamic pool from
  [`cobalt.directory`](https://cobalt.directory)
- **Cache:** [`lru-cache`](https://github.com/isaacs/node-lru-cache)
  with byte-budget eviction
- **Concurrency:** [`p-limit`](https://github.com/sindresorhus/p-limit)
  at two tiers
- **Config:** [`zod`](https://zod.dev) validation at startup

## Honest limits

- **Platforms can break overnight.** TikTok and Instagram actively fight
  scrapers. If the whole cobalt ecosystem is down, so are we.
- **Community cobalt endpoints are unreliable.** They can go offline,
  enable Turnstile, or hit rate limits. The bot auto-bans failing ones
  until the next refresh, but can't make them work.
- **Files > 2 GB won't be sent.** Hard cap to protect RAM. Telegram
  itself also has upload limits (50 MB via Bot API; we use user-client,
  so higher, but not infinite).

## License

[MIT](LICENSE)
