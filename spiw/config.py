from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):

              
    bot_token: str
    service_chat_id: int

            
    max_video_duration_seconds: int = 600            
    processing_concurrency: int = 8
    direct_download_concurrency: int = 6
    max_media_group_items: int = 10

            
    inline_cache_seconds: int = 900                                             
    inline_resolve_timeout: float = 5.0

              
    provider_timeout_seconds: float = 45.0
    http_timeout_seconds: float = 15.0

          
    db_path: Path = Path("data/spiw.db")
    media_temp_dir: Path = Path("/tmp/spiw-media")
    ffmpeg_binary: str = "ffmpeg"
    ffprobe_binary: str = "ffprobe"

                 
    tiktok_fallback_api_url: str = "https://www.tikwm.com/api/"

    model_config = {"env_prefix": "SPIW_"}
