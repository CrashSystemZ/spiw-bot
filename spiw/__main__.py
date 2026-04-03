from __future__ import annotations

import asyncio
import logging
import sys

from spiw.bot import create_bot
from spiw.config import Settings
from spiw.links.normalizers import create_normalizers
from spiw.links.validator import LinkValidator
from spiw.models.enums import Platform
from spiw.pipeline.downloader import YtDlpDownloader
from spiw.pipeline.ffmpeg import FFmpegToolkit
from spiw.pipeline.processor import MediaPipeline
from spiw.providers.instagram import InstagramProvider
from spiw.providers.threads import ThreadsPostProvider
from spiw.providers.tiktok import TikTokProvider
from spiw.providers.x import XPostProvider
from spiw.storage.database import init_database
from spiw.storage.media_cache import MediaCacheRepository
from spiw.storage.memory import InMemoryState
from spiw.telegram.delivery import DeliveryService
from spiw.telegram.handlers import HandlerDeps, register_handlers
from spiw.telegram.orchestrator import MediaOrchestrator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


async def _run() -> None:
    settings = Settings()
    logger.info("Starting spiw-bot v2.0.0")

             
    db = await init_database(settings.db_path)
    media_cache = MediaCacheRepository(db)
    state = InMemoryState()
    state.processing_semaphore = asyncio.Semaphore(settings.processing_concurrency)

               
    providers = {
        Platform.TIKTOK: TikTokProvider(settings),
        Platform.INSTAGRAM: InstagramProvider(settings),
        Platform.X: XPostProvider(settings),
        Platform.THREADS: ThreadsPostProvider(settings),
    }

              
    ffmpeg = FFmpegToolkit(settings.ffmpeg_binary, settings.ffprobe_binary)
    downloader = YtDlpDownloader(settings)
    pipeline = MediaPipeline(downloader, ffmpeg, settings)

              
    bot, dp = create_bot(settings)
    delivery = DeliveryService(bot, settings.service_chat_id)
    orchestrator = MediaOrchestrator(media_cache, state, providers, pipeline, delivery, settings)
    link_validator = LinkValidator(create_normalizers())

              
    deps = HandlerDeps(bot, link_validator, orchestrator, media_cache, state, settings)
    register_handlers(dp, deps)

                           
    async def cleanup_loop() -> None:
        while True:
            await asyncio.sleep(600)                   
            state.cleanup_old_sessions()
            state.cleanup_old_locks()

    asyncio.create_task(cleanup_loop())

           
    logger.info("Bot is starting polling...")
    try:
        await bot.delete_webhook(drop_pending_updates=True)
        await dp.start_polling(
            bot,
            allowed_updates=["inline_query", "chosen_inline_result", "callback_query"],
        )
    finally:
        await db.close()
        logger.info("Bot stopped")


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
