//! Update handlers and the delivery pipeline: link -> cobalt -> Telegram file -> inline message.

use std::{
    collections::HashMap,
    error::Error as StdError,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use grammers_client::{
    message::{Button, InputMessage, ReplyMarkup},
    tl::{self, Serializable},
    update::{Article, CallbackQuery, InlineQuery, InlineSend, Message, Update},
};
use hmac::{Hmac, KeyInit, Mac};
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::{sync::Semaphore, task::JoinSet};
use tracing::{debug, info, warn};

use crate::{
    cobalt::{Budget, Cobalt, Hint, Resolved},
    config::Config,
    db::Db,
    error::{Error, Result},
    meta::{self, Normalized},
    model::{FileRef, Media, MediaKind, Post, hex, post_key},
    net, probe,
    tg::{self, InlineId, Tg, Upload},
    url,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Messages {
    loading: String,
    carousel_expired: String,
    retry_started: String,
    unsupported_link: String,
    media_too_large: String,
    media_unavailable: String,
    local_processing_unsupported: String,
    try_again: String,
    click_to_send: String,
    stats_title: String,
}

/// What a button under a message does. Travels in the callback data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Item(usize),
    Audio(usize),
    Retry,
}

pub struct App {
    cfg: Config,
    db: Db,
    tg: Tg,
    cobalt: Cobalt,
    /// For pages of the supported platforms; refuses private addresses.
    http: reqwest::Client,
    budget: Budget,
    jobs: Semaphore,
    /// One lock per post being built, so simultaneous taps share a single download.
    building: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    signer: Hmac<Sha256>,
    text: Messages,
}

impl App {
    pub fn new(mut cfg: Config, db: Db, tg: Tg) -> std::result::Result<Arc<Self>, Box<dyn StdError + Send + Sync>> {
        let http = net::public_client()?;
        let cobalt = Cobalt::new(std::mem::take(&mut cfg.endpoints), http.clone(), cfg.cobalt_timeout)?;
        let secret = Sha256::new().chain_update("spiw callback v1").chain_update(&cfg.bot_token).finalize();
        Ok(Arc::new(Self {
            budget: Budget::new(cfg.budget_bytes),
            jobs: Semaphore::new(cfg.max_jobs),
            building: Mutex::default(),
            signer: Hmac::new_from_slice(&secret)?,
            text: serde_json::from_str(include_str!("../resources/messages.json"))?,
            cfg,
            db,
            tg,
            cobalt,
            http,
        }))
    }

    pub async fn handle(self: Arc<Self>, update: Update) {
        match update {
            Update::InlineQuery(query) => self.on_query(&query).await,
            Update::InlineSend(sent) => self.on_sent(&sent).await,
            Update::CallbackQuery(query) => self.on_callback(&query).await,
            Update::NewMessage(message) if !message.outgoing() && is_stats_command(message.text()) => Box::pin(self.on_stats(&message)).await,
            _ => {}
        }
    }

    /// Drops posts nobody asked for within the configured lifetime.
    pub fn cleanup(&self) {
        if let Err(error) = self.db.cleanup(self.fresh_since()) {
            warn!(%error, "cleanup failed");
        }
    }

    fn fresh_since(&self) -> i64 {
        now_ms() - i64::try_from(self.cfg.post_ttl.as_millis()).unwrap_or(i64::MAX)
    }

    // ---- inline query: offer a placeholder the user can send --------------------------------

    async fn on_query(&self, query: &InlineQuery) {
        let results = match self.prepare(query.text()).await {
            Ok(Some(post)) => {
                // Telegram reports the id of a sent inline message only if it carries a keyboard
                let keyboard = ReplyMarkup::from_buttons(&[vec![Button::url("📎", post.url)]]);
                let message = InputMessage::new().text(format!("⏳ {}", self.text.loading)).reply_markup(keyboard);
                vec![Article::new(format!("📤 {}", self.text.click_to_send), message).id(post.key)]
            }
            Ok(None) => vec![],
            Err(error) => {
                warn!(%error, "inline query failed");
                let text = self.user_message(&error);
                vec![Article::new(format!("❌ {text}"), InputMessage::new().text(text)).id("error")]
            }
        };
        if let Err(error) = query.answer(results).cache_time(0).private().send().await {
            debug!(%error, "could not answer inline query");
        }
    }

    /// Turns the query text into a stored post. `None` when it holds no supported link.
    async fn prepare(&self, text: &str) -> Result<Option<Post>> {
        let Some(link) = url::parse_input(text) else { return Ok(None) };
        let Some(platform) = meta::platform_of(&link) else { return Ok(None) };
        let alias = url::alias(&link);
        if let Some(post) = self.db.post_by_alias(&alias, self.fresh_since())? {
            // asking for a post again keeps it alive
            self.db.save_post(&post.key, post.platform, &post.url, &[alias], now_ms())?;
            return Ok(Some(post));
        }

        let normalized = meta::normalize(&self.http, &link, self.cfg.resolve_timeout).await.unwrap_or_else(|error| {
            // cobalt may still understand the link as it is
            debug!(%error, "could not normalize link");
            Normalized { platform, url: link.to_string(), media_id: None }
        });
        let key = post_key(normalized.platform, normalized.media_id.as_deref().unwrap_or(&normalized.url));
        let mut aliases = vec![alias];
        aliases.extend(Url::parse(&normalized.url).ok().map(|u| url::alias(&u)).filter(|a| !aliases.contains(a)));
        self.db.save_post(&key, normalized.platform, &normalized.url, &aliases, now_ms())?;
        Ok(self.db.post(&key, 0)?)
    }

    // ---- the placeholder was sent: replace it with the media --------------------------------

    async fn on_sent(self: &Arc<Self>, sent: &InlineSend) {
        let key = sent.result_id();
        let (true, Some(id)) = (is_key(key), sent.message_id()) else { return };
        self.deliver_first(key, &id).await;
    }

    /// First delivery of a post into a message, also after a retry: counted, and failures are shown.
    async fn deliver_first(self: &Arc<Self>, key: &str, id: &InlineId) {
        match self.deliver(key, id, Action::Item(0)).await {
            Ok(media) => {
                let kinds: Vec<_> = media
                    .items
                    .iter()
                    .filter_map(|file| match file.kind {
                        MediaKind::Video => Some("video"),
                        MediaKind::Animation => Some("animation"),
                        _ => None,
                    })
                    .collect();
                if let Err(error) = self.db.record_deliveries(&kinds, now_ms()) {
                    warn!(%error, "could not record delivery");
                }
                info!(key, items = media.items.len(), "delivered");
            }
            Err(error) => self.fail(key, id, &error).await,
        }
    }

    /// Shows `view` of the post in the inline message, uploading its media first if needed.
    async fn deliver(self: &Arc<Self>, key: &str, id: &InlineId, view: Action) -> Result<Media> {
        let post = self.db.post(key, self.fresh_since())?.ok_or(Error::Expired)?;
        let (media, caption) = tokio::join!(self.media(&post), self.caption(&post));
        let mut media = media?;
        if let Err(error) = self.render(key, id, &media, view, &caption).await {
            if !matches!(&error, Error::Telegram(e) if tg::is_stale_file(e)) {
                return Err(error);
            }
            info!(key, "telegram no longer has the file, uploading it again");
            self.db.set_media(key, None)?;
            media = self.media(&Post { media: None, ..post }).await?;
            self.render(key, id, &media, view, &caption).await?;
        }
        Ok(media)
    }

    async fn render(&self, key: &str, id: &InlineId, media: &Media, view: Action, caption: &str) -> Result<()> {
        let total = media.items.len();
        let button = |label: &str, action| Button::data(label, self.encode(id, key, action));
        let (file, rows) = match (view, &media.audio) {
            (Action::Audio(index), Some(audio)) => (audio, vec![vec![button("🖼️", Action::Item(index))]]),
            (Action::Item(index) | Action::Audio(index), _) => {
                let index = if index < total { index } else { 0 };
                let file = media.items.get(index).ok_or_else(|| Error::Internal("post has no media".into()))?;
                let mut rows = Vec::new();
                if total > 1 {
                    rows.push(vec![
                        button("⬅️", Action::Item((index + total - 1) % total)),
                        Button::data(format!("{}/{total}", index + 1), NOOP),
                        button("➡️", Action::Item((index + 1) % total)),
                    ]);
                    if media.audio.is_some() {
                        rows.push(vec![button("🎵", Action::Audio(index))]);
                    }
                }
                (file, rows)
            }
            (Action::Retry, _) => return Err(Error::Internal("retry is not a view".into())),
        };
        let markup = (!rows.is_empty()).then(|| ReplyMarkup::from_buttons(&rows).raw);
        Ok(self.tg.edit(id, caption, Some(file), markup).await?)
    }

    async fn fail(&self, key: &str, id: &InlineId, error: &Error) {
        warn!(key, %error, "delivery failed");
        let can_retry = matches!(error, Error::Unavailable(_) | Error::Telegram(_) | Error::Internal(_));
        let markup = can_retry.then(|| ReplyMarkup::from_buttons(&[vec![Button::data("🔄 Retry", self.encode(id, key, Action::Retry))]]).raw);
        if let Err(error) = self.tg.edit(id, self.user_message(error), None, markup).await {
            debug!(%error, "could not show the error");
        }
    }

    // ---- media: from the database if already on Telegram, otherwise built once ---------------

    async fn media(self: &Arc<Self>, post: &Post) -> Result<Media> {
        if let Some(media) = &post.media {
            return Ok(media.clone());
        }
        let lock = self.building().entry(post.key.clone()).or_default().clone();
        let _building = lock.lock().await;
        let result = self.build_unless_done(post).await;
        // while others wait on this lock it has to stay the one new arrivals find
        let mut building = self.building();
        if Arc::strong_count(&lock) <= 2 {
            building.remove(&post.key);
        }
        result
    }

    fn building(&self) -> MutexGuard<'_, HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
        self.building.lock().unwrap_or_else(PoisonError::into_inner)
    }

    async fn build_unless_done(self: &Arc<Self>, post: &Post) -> Result<Media> {
        // another tap on the same post may have finished while we waited for the lock
        if let Some(media) = self.db.post(&post.key, 0)?.and_then(|p| p.media) {
            return Ok(media);
        }
        let _job = self.jobs.acquire().await.map_err(|_| Error::Internal("shutting down".into()))?;
        let media = self.build(post).await?;
        self.db.set_media(&post.key, Some(&media))?;
        Ok(media)
    }

    async fn build(self: &Arc<Self>, post: &Post) -> Result<Media> {
        match self.cobalt.resolve(&post.url).await? {
            Resolved::Single { url, file_name } => {
                Ok(Media { items: vec![self.fetch(&url, file_name.as_deref(), None).await?], audio: None })
            }
            Resolved::Picker { items, audio } => {
                let limit = Arc::new(Semaphore::new(self.cfg.max_fetches));
                let mut fetches = JoinSet::new();
                for (index, item) in items.into_iter().enumerate() {
                    let (app, limit) = (Arc::clone(self), Arc::clone(&limit));
                    fetches.spawn(async move {
                        let _slot = limit.acquire().await;
                        (index, app.fetch(&item.url, None, Some(item.hint)).await)
                    });
                }
                // dropping the set on the first error cancels the remaining fetches
                let mut files = Vec::with_capacity(fetches.len());
                while let Some(done) = fetches.join_next().await {
                    let (index, file) = done.map_err(|e| Error::Internal(format!("fetch task: {e}")))?;
                    files.push((index, file?));
                }
                files.sort_unstable_by_key(|(index, _)| *index);
                // a slideshow is still worth sending when only its soundtrack fails
                let audio = match audio {
                    Some((url, name)) => self.fetch(&url, name.as_deref(), Some(Hint::Audio)).await.inspect_err(|error| warn!(%error, "soundtrack skipped")).ok(),
                    None => None,
                };
                Ok(Media { items: files.into_iter().map(|(_, file)| file).collect(), audio })
            }
        }
    }

    /// Downloads one file into memory and stores it on Telegram.
    async fn fetch(&self, url: &Url, name: Option<&str>, hint: Option<Hint>) -> Result<FileRef> {
        let file = self.cobalt.download(url, name, self.cfg.max_item_bytes, &self.budget).await?;
        let probe = probe::probe(&file.data);
        let kind = match (probe.kind, hint) {
            // instances that do not convert gifs hand out the silent mp4 and say what it is
            (Some(MediaKind::Video) | None, Some(Hint::Gif)) => MediaKind::Animation,
            (Some(kind), _) => kind,
            (None, Some(Hint::Photo)) => MediaKind::Photo,
            (None, Some(Hint::Video)) => MediaKind::Video,
            (None, Some(Hint::Audio)) => MediaKind::Audio,
            (None, _) => probe::kind_from_name(&file.file_name, file.mime.as_deref()),
        };
        let (extension, mime) = match (probe::container(&file.data), kind) {
            (Some(("mp4", _)), MediaKind::Audio) => ("m4a", "audio/mp4"),
            (Some(found), _) => found,
            (None, _) => ("", file.mime.as_deref().unwrap_or("application/octet-stream")),
        };
        // Telegram refuses a photo whose name has no image extension, and tunnel links carry no name
        let name = if extension.is_empty() || file.file_name.contains('.') { file.file_name.clone() } else { format!("{}.{extension}", file.file_name) };
        debug!(name, mime, ?kind, bytes = file.data.len(), "uploading");
        self.tg.upload(Upload { data: &file.data, name: &name, mime, kind, probe }).await
    }

    /// Caption for the post, fetched once. Empty when the platform's captions are not shown.
    async fn caption(&self, post: &Post) -> String {
        if !post.platform.shows_caption() {
            return String::new();
        }
        if let Some(caption) = &post.caption {
            return caption.clone();
        }
        let timeout = self.cfg.resolve_timeout;
        let details = async {
            // the stored URL is canonical, so this stays offline and recovers the post id
            let normalized = meta::normalize(&self.http, &Url::parse(&post.url).ok()?, timeout).await.ok()?;
            meta::details(&self.http, &normalized, timeout).await.ok()
        };
        // on failure nothing is stored, so the next delivery tries again
        let Some(details) = details.await else { return String::new() };
        let caption = format_caption(details.title.as_deref(), details.caption.as_deref());
        if let Err(error) = self.db.set_caption(&post.key, &caption) {
            warn!(%error, "could not store caption");
        }
        caption
    }

    // ---- buttons ------------------------------------------------------------------------------

    async fn on_callback(self: &Arc<Self>, query: &CallbackQuery) {
        let tl::enums::Update::InlineBotCallbackQuery(raw) = &query.raw else {
            return answer(query, "").await;
        };
        let id = &raw.msg_id;
        let toast = match self.decode(id, query.data()) {
            None if query.data() == NOOP.as_bytes() => "",
            None => &self.text.carousel_expired,
            Some((key, Action::Retry)) => {
                answer(query, &self.text.retry_started).await;
                return self.deliver_first(&key, id).await;
            }
            Some((key, view)) => match self.deliver(&key, id, view).await {
                Ok(_) => "",
                Err(Error::Expired) => &self.text.carousel_expired,
                Err(error) => {
                    warn!(key, %error, "could not switch view");
                    self.user_message(&error)
                }
            },
        };
        answer(query, toast).await;
    }

    /// Callback data is `<action>:<post key>:<index>:<mac>`. The mac ties it to the message it
    /// was issued for, so data copied from one message cannot be replayed on another.
    fn encode(&self, id: &InlineId, key: &str, action: Action) -> Vec<u8> {
        let (code, index) = match action {
            Action::Item(index) => ('i', index),
            Action::Audio(index) => ('a', index),
            Action::Retry => ('r', 0),
        };
        format!("{code}:{key}:{index}:{}", self.mac(id, key)).into_bytes()
    }

    fn decode(&self, id: &InlineId, data: &[u8]) -> Option<(String, Action)> {
        let mut parts = std::str::from_utf8(data).ok()?.split(':');
        let (code, key, index, mac) = (parts.next()?, parts.next()?, parts.next()?.parse().ok()?, parts.next()?);
        if parts.next().is_some() || !is_key(key) || !constant_time_eq(mac.as_bytes(), self.mac(id, key).as_bytes()) {
            return None;
        }
        let action = match code {
            "i" => Action::Item(index),
            "a" => Action::Audio(index),
            "r" => Action::Retry,
            _ => return None,
        };
        Some((key.to_owned(), action))
    }

    fn mac(&self, id: &InlineId, key: &str) -> String {
        let tag = self.signer.clone().chain_update(id.to_bytes()).chain_update(key).finalize().into_bytes();
        hex(&tag[..8])
    }

    // ---- /stats -------------------------------------------------------------------------------

    async fn on_stats(&self, message: &Message) {
        let reply = match self.db.stats(now_ms() - DAY_MS) {
            Ok((day, total)) => format!("{}\n\nLast 24h: {day}\nAll time: {total}", self.text.stats_title),
            Err(error) => {
                warn!(%error, "stats query failed");
                self.text.try_again.clone()
            }
        };
        if let Err(error) = Box::pin(message.reply(reply)).await {
            debug!(%error, "could not send stats");
        }
    }

    fn user_message(&self, error: &Error) -> &str {
        match error {
            Error::Unsupported => &self.text.unsupported_link,
            Error::TooLarge => &self.text.media_too_large,
            Error::LocalProcessing => &self.text.local_processing_unsupported,
            Error::Expired | Error::Unavailable(_) => &self.text.media_unavailable,
            Error::Telegram(_) | Error::Internal(_) => &self.text.try_again,
        }
    }
}

/// Callback data of the page counter button, which does nothing.
const NOOP: &str = "n";

async fn answer(query: &CallbackQuery, toast: &str) {
    let reply = if toast.is_empty() { query.answer() } else { query.answer().text(toast) };
    if let Err(error) = reply.send().await {
        debug!(%error, "could not answer callback");
    }
}

fn is_key(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_stats_command(text: &str) -> bool {
    let command = text.split_whitespace().next().unwrap_or_default();
    command == "/stats" || command.starts_with("/stats@")
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn now_ms() -> i64 {
    let since_epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    i64::try_from(since_epoch.as_millis()).unwrap_or(i64::MAX)
}

/// Title and text of a post as one caption, without saying the same thing twice.
fn format_caption(title: Option<&str>, text: Option<&str>) -> String {
    fn clean(s: Option<&str>) -> Option<&str> {
        s.map(str::trim).filter(|s| !s.is_empty())
    }
    let caption = match (clean(title), clean(text)) {
        (Some(title), Some(text)) => {
            let (lower_title, lower_text) = (title.to_lowercase(), text.to_lowercase());
            if lower_text.contains(&lower_title) {
                text.to_owned()
            } else if lower_title.contains(&lower_text) {
                title.to_owned()
            } else {
                format!("{title}\n\n{text}")
            }
        }
        (Some(only), None) | (None, Some(only)) => only.to_owned(),
        (None, None) => String::new(),
    };
    truncate_utf16(&caption, 1000)
}

/// Telegram limits captions to 1024 UTF-16 units.
fn truncate_utf16(text: &str, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text.to_owned();
    }
    let mut units = 0;
    let kept: String = text
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max - 3
        })
        .collect();
    format!("{kept}...")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caption_merges_title_and_text() {
        assert_eq!(format_caption(None, None), "");
        assert_eq!(format_caption(Some("  "), Some(" body ")), "body");
        assert_eq!(format_caption(Some("Title"), None), "Title");
        assert_eq!(format_caption(Some("Title"), Some("Body")), "Title\n\nBody");
        assert_eq!(format_caption(Some("hello"), Some("Hello world")), "Hello world");
        assert_eq!(format_caption(Some("Hello World!"), Some("hello")), "Hello World!");
    }

    #[test]
    fn caption_is_cut_in_utf16_units() {
        assert_eq!(truncate_utf16("short", 1000), "short");
        let long = "😀".repeat(600); // 1200 units
        let cut = truncate_utf16(&long, 1000);
        assert!(cut.ends_with("..."));
        assert_eq!(cut.encode_utf16().count(), 996 + 3, "498 whole emoji, never half of one");
    }

    #[test]
    fn recognises_keys_and_commands() {
        assert!(is_key("0123456789abcdef0123456789abcdef"));
        for bad in ["", "error", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0"] {
            assert!(!is_key(bad), "{bad}");
        }
        assert!(is_stats_command("/stats"));
        assert!(is_stats_command("/stats@spiw_bot now"));
        assert!(!is_stats_command("/statsx"));
        assert!(!is_stats_command("hello /stats"));
    }

    #[test]
    fn sniffs_what_a_file_really_is() {
        let sniff = probe::container;
        assert_eq!(sniff(include_bytes!("../tests/fixtures/photo.jpg")), Some(("jpg", "image/jpeg")));
        assert_eq!(sniff(include_bytes!("../tests/fixtures/photo.png")), Some(("png", "image/png")));
        assert_eq!(sniff(include_bytes!("../tests/fixtures/anim.gif")), Some(("gif", "image/gif")));
        assert_eq!(sniff(include_bytes!("../tests/fixtures/fragmented.mp4")), Some(("mp4", "video/mp4")));
        assert_eq!(sniff(include_bytes!("../tests/fixtures/audio.m4a")), Some(("mp4", "video/mp4")));
        assert_eq!(sniff(include_bytes!("../tests/fixtures/tagged.mp3")), Some(("mp3", "audio/mpeg")));
        assert_eq!(sniff(include_bytes!("../tests/fixtures/bare.mp3")), Some(("mp3", "audio/mpeg")));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(("webp", "image/webp")));
        assert_eq!(sniff(b"<!doctype html>"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn compares_in_constant_time_shape() {
        assert!(constant_time_eq(b"abcd", b"abcd"));
        assert!(!constant_time_eq(b"abcd", b"abce"));
        assert!(!constant_time_eq(b"abcd", b"abc"));
    }
}
