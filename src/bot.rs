//! Update handlers and the delivery pipeline: link -> cobalt -> Telegram file -> inline message.

use std::{
    collections::HashMap,
    error::Error as StdError,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use grammers_client::{
    message::{Button, InputMessage, ReplyMarkup},
    tl,
    update::{Article, CallbackQuery, InlineQuery, InlineSend, Message, Update},
};
use reqwest::Url;
use serde::Deserialize;
use tokio::{sync::Semaphore, task::JoinSet};
use tracing::{debug, info, warn};

use crate::{
    cobalt::{Budget, Cobalt, Hint, Resolved},
    config::Config,
    db::Db,
    error::{Error, Result},
    meta::{self, Normalized},
    model::{FileRef, MediaKind, Post, post_key},
    net, probe,
    tg::{self, InlineId, Tg, Upload},
    url,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Files of one post fetched at the same time.
const PARALLEL_FETCHES: usize = 4;
/// Starts the id of an inline result that carries the file itself rather than a placeholder.
const READY: &str = "+";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Messages {
    loading: String,
    unsupported_link: String,
    media_too_large: String,
    media_unavailable: String,
    local_processing_unsupported: String,
    try_again: String,
    click_to_send: String,
    stats_title: String,
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
    /// One lock per post being built, so simultaneous sends share a single download.
    building: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    text: Messages,
}

impl App {
    pub fn new(mut cfg: Config, db: Db, tg: Tg) -> std::result::Result<Arc<Self>, Box<dyn StdError + Send + Sync>> {
        let http = net::public_client()?;
        let cobalt = Cobalt::new(std::mem::take(&mut cfg.endpoints), http.clone(), cfg.cobalt_timeout)?;
        Ok(Arc::new(Self {
            budget: Budget::new(cfg.budget_bytes),
            jobs: Semaphore::new(cfg.max_jobs),
            building: Mutex::default(),
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

    // ---- inline query: offer the post, or a placeholder for one not uploaded yet -----------

    async fn on_query(&self, query: &InlineQuery) {
        let answer = |results: Vec<tl::enums::InputBotInlineResult>| query.answer(results).cache_time(0).private();
        let title = format!("📤 {}", self.text.click_to_send);
        let results = match self.prepare(query.text()).await {
            Ok(Some(post)) => {
                if let Some((files @ [first, ..], caption)) = ready(&post) {
                    let result = tg::file_result(format!("{READY}{}", post.key), &title, first, caption, paging(&post.key, 0, files.len()));
                    let offer = answer(vec![result]);
                    // photos and animations are picked from a grid of previews, the rest from a list with titles
                    let offer = if matches!(first.kind, MediaKind::Photo | MediaKind::Animation) { offer.gallery() } else { offer };
                    match offer.send().await {
                        Ok(()) => return,
                        // Telegram may have dropped the file; the placeholder leads to a fresh upload
                        Err(error) => info!(key = post.key, %error, "could not offer the stored file"),
                    }
                }
                // Telegram tells a bot which inline message was sent only if that message has a
                // keyboard, so the placeholder needs one button. It goes away with the placeholder.
                let keyboard = ReplyMarkup::from_buttons(&[vec![Button::url("📎", post.url)]]);
                let message = InputMessage::new().text(format!("⏳ {}", self.text.loading)).reply_markup(keyboard);
                vec![Article::new(title, message).id(post.key).into()]
            }
            Ok(None) => vec![],
            Err(error) => {
                warn!(%error, "inline query failed");
                let text = self.user_message(&error);
                vec![Article::new(format!("❌ {text}"), InputMessage::new().text(text)).id("error").into()]
            }
        };
        if let Err(error) = answer(results).send().await {
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

    // ---- a result was sent: replace the placeholder with the media ---------------------------

    async fn on_sent(self: &Arc<Self>, sent: &InlineSend) {
        let id = sent.result_id();
        if let Some(key) = id.strip_prefix(READY).filter(|key| is_key(key)) {
            // the user sent the file itself; there is nothing to replace
            let files = self.db.post(key, 0).ok().flatten().and_then(|post| post.media).unwrap_or_default();
            return self.count(key, &files);
        }
        let (true, Some(message)) = (is_key(id), sent.message_id()) else { return };
        match self.deliver(id, &message, 0).await {
            Ok(files) => self.count(id, &files),
            Err(error) => {
                warn!(key = id, %error, "delivery failed");
                if let Err(error) = self.tg.edit(&message, self.user_message(&error), None, None).await {
                    debug!(%error, "could not show the error");
                }
            }
        }
    }

    fn count(&self, key: &str, files: &[FileRef]) {
        let kinds: Vec<_> = files
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
        info!(key, files = files.len(), "delivered");
    }

    /// A paging button was pressed: show the file it stands for.
    async fn on_callback(self: &Arc<Self>, query: &CallbackQuery) {
        let toast = match (&query.raw, parse_page(query.data())) {
            (tl::enums::Update::InlineBotCallbackQuery(raw), Some((key, index))) => match self.deliver(key, &raw.msg_id, index).await {
                Ok(_) => "",
                Err(error) => {
                    warn!(key, %error, "could not turn the page");
                    self.user_message(&error)
                }
            },
            // a button from an earlier version; just stop its spinner
            _ => "",
        };
        let answer = if toast.is_empty() { query.answer() } else { query.answer().text(toast) };
        if let Err(error) = answer.send().await {
            debug!(%error, "could not answer callback");
        }
    }

    /// Puts file `index` of the post into the inline message, uploading the post first if needed.
    async fn deliver(self: &Arc<Self>, key: &str, id: &InlineId, index: usize) -> Result<Vec<FileRef>> {
        let post = self.db.post(key, self.fresh_since())?.ok_or(Error::Expired)?;
        let (files, caption) = tokio::join!(self.media(&post), self.caption(&post));
        let mut files = files?;
        if let Err(error) = self.show(key, id, &files, index, &caption).await {
            if !matches!(&error, Error::Telegram(e) if tg::is_stale_file(e)) {
                return Err(error);
            }
            info!(key, "telegram no longer has the file, uploading it again");
            self.db.set_media(key, None)?;
            files = self.media(&Post { media: None, ..post }).await?;
            self.show(key, id, &files, index, &caption).await?;
        }
        Ok(files)
    }

    async fn show(&self, key: &str, id: &InlineId, files: &[FileRef], index: usize, caption: &str) -> Result<()> {
        // a post uploaded again may have fewer files than the pressed button was made for
        let index = if index < files.len() { index } else { 0 };
        let file = files.get(index).ok_or_else(|| Error::Internal("post has no media".into()))?;
        Ok(self.tg.edit(id, caption, Some(file), paging(key, index, files.len())).await?)
    }

    // ---- media: from the database if already on Telegram, otherwise built once ---------------

    async fn media(self: &Arc<Self>, post: &Post) -> Result<Vec<FileRef>> {
        if let Some(files) = &post.media {
            return Ok(files.clone());
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

    async fn build_unless_done(self: &Arc<Self>, post: &Post) -> Result<Vec<FileRef>> {
        // another send of the same post may have finished while we waited for the lock
        if let Some(files) = self.db.post(&post.key, 0)?.and_then(|p| p.media) {
            return Ok(files);
        }
        let _job = self.jobs.acquire().await.map_err(|_| Error::Internal("shutting down".into()))?;
        let files = self.build(post).await?;
        self.db.set_media(&post.key, Some(&files))?;
        Ok(files)
    }

    /// Resolves the post through cobalt and stores each of its files on Telegram, a few at a time.
    async fn build(self: &Arc<Self>, post: &Post) -> Result<Vec<FileRef>> {
        let limit = Arc::new(Semaphore::new(PARALLEL_FETCHES));
        let mut fetches = JoinSet::new();
        for (index, source) in self.cobalt.resolve(&post.url).await?.into_iter().enumerate() {
            let (app, limit) = (Arc::clone(self), Arc::clone(&limit));
            fetches.spawn(async move {
                let _slot = limit.acquire().await;
                (index, app.fetch(&source).await)
            });
        }
        // returning on the first error drops the set, which cancels the remaining fetches
        let mut files = Vec::with_capacity(fetches.len());
        while let Some(done) = fetches.join_next().await {
            let (index, file) = done.map_err(|e| Error::Internal(format!("fetch task: {e}")))?;
            files.push((index, file?));
        }
        files.sort_unstable_by_key(|(index, _)| *index);
        Ok(files.into_iter().map(|(_, file)| file).collect())
    }

    /// Downloads one file into memory and stores it on Telegram.
    async fn fetch(&self, source: &Resolved) -> Result<FileRef> {
        let file = self.cobalt.download(&source.url, source.file_name.as_deref(), self.cfg.max_item_bytes, &self.budget).await?;
        let probe = probe::probe(&file.data);
        let kind = match (probe.kind, source.hint) {
            // instances that do not convert gifs hand out the silent mp4 and say what it is
            (Some(MediaKind::Video) | None, Some(Hint::Gif)) => MediaKind::Animation,
            (Some(kind), _) => kind,
            (None, Some(Hint::Photo)) => MediaKind::Photo,
            (None, Some(Hint::Video)) => MediaKind::Video,
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

/// What can be sent without a placeholder: the post's files and its caption, all already known.
fn ready(post: &Post) -> Option<(&[FileRef], &str)> {
    let caption = if post.platform.shows_caption() { post.caption.as_deref()? } else { "" };
    Some((post.media.as_deref()?, caption))
}

/// ⬅️ 2/5 ➡️ under a post with several files, nothing under a post with one. Each button carries
/// `<post key>:<file index>`. Telegram accepts a press only with data that is on a button of that
/// very message, so the data needs no signature.
fn paging(key: &str, index: usize, total: usize) -> Option<tl::enums::ReplyMarkup> {
    (total > 1).then(|| {
        let page = |label: String, to: usize| Button::data(label, format!("{key}:{to}"));
        let row = vec![
            page("⬅️".into(), (index + total - 1) % total),
            page(format!("{}/{total}", index + 1), index),
            page("➡️".into(), (index + 1) % total),
        ];
        ReplyMarkup::from_buttons(&[row]).raw
    })
}

fn parse_page(data: &[u8]) -> Option<(&str, usize)> {
    let (key, index) = std::str::from_utf8(data).ok()?.split_once(':')?;
    Some((key, index.parse().ok()?)).filter(|(key, _)| is_key(key))
}

fn is_key(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_stats_command(text: &str) -> bool {
    let command = text.split_whitespace().next().unwrap_or_default();
    command == "/stats" || command.starts_with("/stats@")
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
    fn paging_buttons_lead_to_their_neighbours() {
        let key = "0123456789abcdef0123456789abcdef";
        let targets = |index, total| -> Vec<usize> {
            let Some(tl::enums::ReplyMarkup::ReplyInlineMarkup(markup)) = paging(key, index, total) else { return vec![] };
            let [tl::enums::KeyboardInlineButtonRow::Row(row)] = markup.rows.as_slice() else { panic!("expected one row") };
            row.buttons
                .iter()
                .map(|button| {
                    let tl::enums::KeyboardInlineButton::Button(button) = button;
                    let tl::enums::InlineButtonType::Callback(press) = &button.r#type else { panic!("expected a callback button") };
                    let (found, to) = parse_page(&press.data).unwrap();
                    assert_eq!(found, key);
                    to
                })
                .collect()
        };
        assert_eq!(targets(0, 3), [2, 0, 1], "wraps to the last file");
        assert_eq!(targets(2, 3), [1, 2, 0], "wraps to the first file");
        assert!(targets(0, 1).is_empty(), "one file needs no buttons");
        assert_eq!(targets(0, 0), [0usize; 0]);

        for bad in [&b"n"[..], b"0123456789abcdef0123456789abcdef", b"0123456789abcdef0123456789abcdef:-1", b"short:1", b"\xff:1"] {
            assert!(parse_page(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn only_a_fully_known_post_is_sent_as_it_is() {
        let file = FileRef { kind: MediaKind::Video, id: 1, access_hash: 2, file_reference: vec![3] };
        let post = |platform, caption: Option<&str>, media| Post { key: String::new(), platform, url: String::new(), caption: caption.map(str::to_owned), media };
        assert!(ready(&post(crate::model::Platform::Tiktok, None, None)).is_none(), "not uploaded yet");
        assert_eq!(ready(&post(crate::model::Platform::Tiktok, Some("ignored"), Some(vec![file.clone()]))).unwrap().1, "");
        assert!(ready(&post(crate::model::Platform::X, None, Some(vec![file.clone()]))).is_none(), "caption not fetched yet");
        assert_eq!(ready(&post(crate::model::Platform::X, Some("text"), Some(vec![file]))).unwrap().1, "text");
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
}
