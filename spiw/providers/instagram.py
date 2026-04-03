from __future__ import annotations

import asyncio
from urllib.parse import urlparse

import instaloader

from spiw.config import Settings
from spiw.errors import MediaUnavailableError
from spiw.models.enums import MediaKind, Platform
from spiw.models.media import ResolvedAsset, ResolvedMediaItem
from spiw.providers.yt_dlp_base import YtDlpProviderBase


class InstagramProvider(YtDlpProviderBase):
    platform = Platform.INSTAGRAM

    async def resolve(self, url: str, media_id: str) -> ResolvedAsset:
        if "/p/" in url:
            try:
                return await asyncio.wait_for(
                    asyncio.to_thread(self._resolve_post_via_instaloader, url, media_id),
                    timeout=self._settings.provider_timeout_seconds,
                )
            except TimeoutError as exc:
                raise MediaUnavailableError("The provider is taking too long to respond") from exc
            except MediaUnavailableError:
                raise
            except Exception as exc:
                raise MediaUnavailableError("Failed to extract source metadata") from exc
        return await super().resolve(url, media_id)

    def _resolve_post_via_instaloader(self, url: str, media_id: str) -> ResolvedAsset:
        shortcode = media_id
        if not shortcode:
            raise MediaUnavailableError("Instagram post shortcode not found")

        loader = instaloader.Instaloader(
            quiet=True,
            download_pictures=False,
            download_videos=False,
            download_video_thumbnails=False,
            download_comments=False,
            save_metadata=False,
            compress_json=False,
        )
        loader.context.error = lambda *args, **kwargs: None
        post = instaloader.Post.from_shortcode(loader.context, shortcode)
        node = post._node

        items = self._collect_items_from_node(node)
        if not items:
            raise MediaUnavailableError("The Instagram post does not contain supported media")

        caption = self._caption_from_node(node)
        username = self._owner_username(node)
        title = f"Post by {username}" if username else None

        return ResolvedAsset(
            platform=self.platform,
            items=items,
            force_direct_download=True,
            title=title,
            description=caption,
            thumbnail_url=node.get("thumbnail_src") or (items[0].source_url if items else None),
            source_url=url,
            like_count=self._as_int((node.get("edge_media_preview_like") or {}).get("count")),
            comment_count=self._as_int((node.get("edge_media_preview_comment") or {}).get("count")),
        )

    def _collect_items_from_node(self, node: dict) -> list[ResolvedMediaItem]:
        sidecar_edges = (node.get("edge_sidecar_to_children") or {}).get("edges") or []
        if sidecar_edges:
            return [
                self._resolved_item_from_node(edge.get("node") or {}, position)
                for position, edge in enumerate(sidecar_edges, start=1)
                if edge.get("node")
            ]
        return [self._resolved_item_from_node(node, 1)]

    def _resolved_item_from_node(self, node: dict, position: int) -> ResolvedMediaItem:
        is_video = bool(node.get("is_video"))
        source_url = self._best_node_url(node)
        if not source_url:
            raise MediaUnavailableError("Instagram post item does not have a downloadable URL")

        dimensions = node.get("dimensions") or {}
        return ResolvedMediaItem(
            kind=MediaKind.VIDEO if is_video else MediaKind.PHOTO,
            position=position,
            width=self._as_int(dimensions.get("width")),
            height=self._as_int(dimensions.get("height")),
            duration=self._as_float(node.get("video_duration")),
            ext=self._extension_from_url(source_url, is_video),
            source_url=source_url,
        )

    @staticmethod
    def _caption_from_node(node: dict) -> str | None:
        edges = (node.get("edge_media_to_caption") or {}).get("edges") or []
        if not edges:
            return None
        text = ((edges[0] or {}).get("node") or {}).get("text")
        return text.strip() if isinstance(text, str) and text.strip() else None

    @staticmethod
    def _owner_username(node: dict) -> str | None:
        owner = node.get("owner") or {}
        username = owner.get("username")
        return username.strip() if isinstance(username, str) and username.strip() else None

    @staticmethod
    def _best_node_url(node: dict) -> str | None:
        if node.get("is_video"):
            video_url = node.get("video_url")
            if isinstance(video_url, str) and video_url.startswith("http"):
                return video_url
        resources = node.get("display_resources") or []
        for resource in reversed(resources):
            src = resource.get("src")
            if isinstance(src, str) and src.startswith("http"):
                return src
        display_url = node.get("display_url")
        if isinstance(display_url, str) and display_url.startswith("http"):
            return display_url
        return None

    @staticmethod
    def _extension_from_url(source_url: str, is_video: bool) -> str:
        path = urlparse(source_url).path
        suffix = path.rsplit(".", maxsplit=1)[-1].lower() if "." in path else ""
        return suffix if suffix else ("mp4" if is_video else "jpg")
