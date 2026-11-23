//! Client for the cobalt API (<https://github.com/imputnet/cobalt/blob/main/docs/api.md>).

use std::{
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use reqwest::{
    Client, Url,
    header::{ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE},
};
use serde::Deserialize;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tracing::warn;

use crate::{
    config::Endpoint,
    error::{Error, Result},
    net,
};

/// An instance that rejected our credentials is skipped for this long.
const BAN: Duration = Duration::from_secs(3600);
const MAX_PICKER_ITEMS: usize = 50;
const BUDGET_UNIT: u64 = 64 * 1024;
const BUDGET_STEP: u64 = 4 << 20;
const BUDGET_WAIT: Duration = Duration::from_secs(60);
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(600);
const EMPTY_BODY: &str = "empty body";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Hint {
    Photo,
    Video,
    Gif,
    /// A picker item type this build does not know; the file itself decides.
    #[serde(other)]
    Unknown,
}

/// Where to download one file of a post from.
pub struct Resolved {
    pub url: Url,
    pub file_name: Option<String>,
    /// What cobalt says the file is, when it says.
    pub hint: Option<Hint>,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
enum ApiResponse {
    Tunnel { url: String, filename: Option<String> },
    Redirect { url: String, filename: Option<String> },
    Picker { picker: Vec<ApiItem> },
    LocalProcessing {},
    Error { error: ApiError },
}

#[derive(Deserialize)]
struct ApiItem {
    #[serde(rename = "type")]
    hint: Hint,
    url: String,
}

#[derive(Deserialize)]
struct ApiError {
    code: String,
}

/// Caps how many media bytes are held in memory at once, across all downloads.
pub struct Budget {
    permits: Arc<Semaphore>,
    total: u64,
}

impl Budget {
    pub fn new(bytes: u64) -> Self {
        let total = (bytes / BUDGET_UNIT).clamp(1, u64::from(u32::MAX));
        Self { permits: Arc::new(Semaphore::new(usize::try_from(total).unwrap_or(usize::MAX))), total }
    }

    async fn reserve(&self, bytes: u64) -> Result<OwnedSemaphorePermit> {
        let units = bytes.div_ceil(BUDGET_UNIT);
        if units > self.total {
            return Err(Error::TooLarge);
        }
        let units = u32::try_from(units).map_err(|_| Error::TooLarge)?;
        match tokio::time::timeout(BUDGET_WAIT, self.permits.clone().acquire_many_owned(units)).await {
            Ok(Ok(permit)) => Ok(permit),
            _ => Err(Error::Unavailable("memory budget exhausted".into())),
        }
    }
}

/// A downloaded file. Dropping it returns its bytes to the budget.
pub struct Downloaded {
    pub data: Vec<u8>,
    pub file_name: String,
    pub mime: Option<String>,
    _reserved: OwnedSemaphorePermit,
}

enum Outcome {
    /// The instance answered about the content; asking another one would not help.
    Done(Result<Vec<Resolved>>),
    Next { code: String, ban: bool },
}

pub struct Cobalt {
    /// Talks to instances on our own private addresses.
    api: Client,
    /// Talks to everything else and refuses private addresses.
    public: Client,
    endpoints: Vec<Endpoint>,
    banned_until: Mutex<Vec<Option<Instant>>>,
    timeout: Duration,
}

impl Cobalt {
    pub fn new(endpoints: Vec<Endpoint>, public: Client, timeout: Duration) -> reqwest::Result<Self> {
        let banned_until = Mutex::new(vec![None; endpoints.len()]);
        Ok(Self { api: net::endpoint_client()?, public, endpoints, banned_until, timeout })
    }

    /// The files of a post, in order. Never empty.
    pub async fn resolve(&self, url: &str) -> Result<Vec<Resolved>> {
        let mut last = Error::Unavailable("no cobalt instance available".into());
        for (index, endpoint) in self.endpoints.iter().enumerate() {
            if self.is_banned(index) {
                continue;
            }
            match self.ask(endpoint, url).await {
                Outcome::Done(result) => return result,
                Outcome::Next { code, ban } => {
                    warn!(instance = endpoint.name(), code, ban, "cobalt instance failed");
                    if ban {
                        self.banned()[index] = Some(Instant::now() + BAN);
                    }
                    last = Error::Unavailable(code);
                }
            }
        }
        Err(last)
    }

    fn banned(&self) -> std::sync::MutexGuard<'_, Vec<Option<Instant>>> {
        self.banned_until.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_banned(&self, index: usize) -> bool {
        self.banned().get(index).copied().flatten().is_some_and(|until| until > Instant::now())
    }

    /// Instances on a private address are ours by configuration. Anything else is reached
    /// through the filtered client, so a remote instance cannot resolve to an inside address.
    fn client(&self, endpoint: &Endpoint) -> &Client {
        if net::is_internal(&endpoint.base) { &self.api } else { &self.public }
    }

    async fn ask(&self, endpoint: &Endpoint, url: &str) -> Outcome {
        let body = serde_json::json!({
            "url": url,
            "downloadMode": "auto",
            "filenameStyle": "basic",
            "videoQuality": "1080",
            "allowH265": false,
            "audioFormat": "mp3",
            // every file comes through the instance: it knows what each CDN expects,
            // and the bot never has to talk to those CDNs itself
            "alwaysProxy": true,
            // an X gif stays the small silent mp4 it is; Telegram shows that as an animation on its own
            "convertGif": false,
            "localProcessing": "disabled",
        });
        let mut code = String::new();
        for delay in [0, 750] {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let mut request = self.client(endpoint).post(endpoint.base.clone()).timeout(self.timeout).header(ACCEPT, "application/json").json(&body);
            if let Some(auth) = &endpoint.auth {
                request = request.header(AUTHORIZATION, auth);
            }
            let response = match request.send().await {
                Ok(response) => response,
                Err(e) => return Outcome::Next { code: format!("network: {e}"), ban: false },
            };
            let status = response.status().as_u16();
            let parsed = net::read_capped(response, 1 << 20).await.ok().and_then(|body| serde_json::from_slice(&body).ok());
            code = match parsed {
                Some(ApiResponse::Error { error }) => error.code,
                Some(ApiResponse::LocalProcessing {}) => return Outcome::Done(Err(Error::LocalProcessing)),
                Some(found) => return Outcome::Done(resolved(found, endpoint)),
                None => return Outcome::Next { code: format!("http {status}"), ban: matches!(status, 401 | 403 | 407) },
            };
            if let Some(error) = content_error(&code) {
                return Outcome::Done(Err(error));
            }
            // the source refusing cobalt is often momentary
            if !matches!(code.as_str(), "error.api.fetch.fail" | "error.api.fetch.empty") {
                break;
            }
        }
        Outcome::Next { ban: code.starts_with("error.api.auth."), code }
    }

    /// Downloads `url` into memory, at most `max` bytes.
    pub async fn download(&self, url: &Url, preferred_name: Option<&str>, max: u64, budget: &Budget) -> Result<Downloaded> {
        // the client's read timeout catches a peer that stalls; this catches one that drips
        let once = || async {
            let download = self.download_once(url, preferred_name, max, budget);
            tokio::time::timeout(DOWNLOAD_DEADLINE, download).await.unwrap_or_else(|_| Err(Error::Unavailable("download took too long".into())))
        };
        match once().await {
            // cobalt sometimes answers 200 with an empty body while a tunnel warms up
            Err(Error::Unavailable(why)) if why == EMPTY_BODY => {
                tokio::time::sleep(Duration::from_millis(500)).await;
                once().await
            }
            result => result,
        }
    }

    async fn download_once(&self, url: &Url, preferred_name: Option<&str>, max: u64, budget: &Budget) -> Result<Downloaded> {
        // credentials only ever go back to the instance they belong to
        let request = match self.endpoints.iter().find(|e| e.base.origin() == url.origin()) {
            Some(endpoint) => {
                let request = self.client(endpoint).get(url.clone());
                match &endpoint.auth {
                    Some(auth) => request.header(AUTHORIZATION, auth),
                    None => request,
                }
            }
            None => self.public.get(url.clone()),
        };
        let mut response = request.send().await.map_err(|e| Error::Unavailable(format!("download: {e}")))?;
        if !response.status().is_success() {
            return Err(Error::Unavailable(format!("download: http {}", response.status().as_u16())));
        }

        let header = |name| response.headers().get(name).and_then(|v| v.to_str().ok());
        let mime = header(CONTENT_TYPE).and_then(|v| v.split(';').next()).map(|m| m.trim().to_ascii_lowercase());
        let expected = header(CONTENT_LENGTH).and_then(|v| v.parse::<u64>().ok());
        if expected.is_some_and(|len| len > max) {
            return Err(Error::TooLarge);
        }

        // The declared length only sizes the allocation, which costs nothing until written to.
        // The budget is charged for bytes that actually arrived, so a peer cannot pin it with a header.
        let mut data = Vec::new();
        data.try_reserve_exact(usize::try_from(expected.unwrap_or(0)).unwrap_or(usize::MAX)).map_err(|_| Error::TooLarge)?;
        let mut paid = 0;
        let mut permit: Option<OwnedSemaphorePermit> = None;
        while let Some(chunk) = response.chunk().await.map_err(|e| Error::Unavailable(format!("download: {e}")))? {
            let total = (data.len() + chunk.len()) as u64;
            if total > max {
                return Err(Error::TooLarge);
            }
            if total > paid {
                let extra = (total - paid).max(BUDGET_STEP);
                let more = budget.reserve(extra).await?;
                match &mut permit {
                    Some(held) => held.merge(more),
                    None => permit = Some(more),
                }
                paid += extra;
            }
            data.extend_from_slice(&chunk);
        }
        let Some(permit) = permit else { return Err(Error::Unavailable(EMPTY_BODY.into())) };

        let file_name = preferred_name.or_else(|| url.path_segments()?.next_back()).map(clean_name).filter(|n| !n.is_empty());
        Ok(Downloaded { data, file_name: file_name.unwrap_or_else(|| "media".into()), mime, _reserved: permit })
    }
}

fn resolved(response: ApiResponse, endpoint: &Endpoint) -> Result<Vec<Resolved>> {
    let files: Vec<_> = match response {
        ApiResponse::Tunnel { url, filename } | ApiResponse::Redirect { url, filename } => {
            media_url(&url, endpoint).map(|url| Resolved { url, file_name: filename, hint: None }).into_iter().collect()
        }
        ApiResponse::Picker { picker } => picker
            .into_iter()
            .filter_map(|item| Some(Resolved { url: media_url(&item.url, endpoint)?, file_name: None, hint: Some(item.hint) }))
            .take(MAX_PICKER_ITEMS)
            .collect(),
        ApiResponse::LocalProcessing {} | ApiResponse::Error { .. } => vec![],
    };
    if files.is_empty() {
        return Err(Error::Unavailable("cobalt returned an unusable link".into()));
    }
    Ok(files)
}

/// A link handed out by `endpoint`. An instance configured with an internal name for itself
/// (`http://cobalt:9000/`) builds tunnel links with that name; those are pointed back at the
/// instance. This also means an instance can never aim us at somebody else's private address.
fn media_url(raw: &str, endpoint: &Endpoint) -> Option<Url> {
    let mut url = Url::parse(raw).ok().filter(|u| matches!(u.scheme(), "http" | "https"))?;
    if net::is_internal(&url) && url.origin() != endpoint.base.origin() {
        url.set_scheme(endpoint.base.scheme()).ok()?;
        url.set_host(endpoint.base.host_str()).ok()?;
        url.set_port(endpoint.base.port()).ok()?;
    }
    Some(url)
}

fn content_error(code: &str) -> Option<Error> {
    match code {
        "error.api.service.unsupported" | "error.api.service.disabled" | "error.api.link.invalid" | "error.api.link.unsupported" => {
            Some(Error::Unsupported)
        }
        "error.api.content.too_long" => Some(Error::TooLarge),
        "error.api.content.video.private" | "error.api.content.post.private" => Some(Error::Private),
        "error.api.content.video.age" | "error.api.content.post.age" => Some(Error::AgeRestricted),
        "error.api.content.video.unavailable" | "error.api.content.video.live" | "error.api.content.video.region" | "error.api.content.post.unavailable" => {
            Some(Error::Unavailable(code.into()))
        }
        _ => None,
    }
}

/// File names come from the network and end up in Telegram attributes.
fn clean_name(name: &str) -> String {
    name.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\')).take(120).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(base: &str) -> Endpoint {
        Endpoint { base: Url::parse(base).unwrap(), auth: None }
    }

    fn parse(json: &str) -> Result<Vec<Resolved>> {
        resolved(serde_json::from_str(json).unwrap(), &endpoint("https://co.example/"))
    }

    #[test]
    fn parses_api_responses() {
        let single = parse(r#"{"status":"tunnel","url":"https://co.example/tunnel?id=1","filename":"a.mp4"}"#).unwrap();
        let [single] = single.as_slice() else { panic!("expected one file") };
        assert_eq!((single.url.as_str(), single.file_name.as_deref(), single.hint), ("https://co.example/tunnel?id=1", Some("a.mp4"), None));

        let several = parse(
            r#"{"status":"picker","audio":"https://co.example/a","audioFilename":"a.mp3",
                "picker":[{"type":"gif","url":"ftp://x/1"},{"type":"photo","url":"https://cdn.example/2.jpg"},{"type":"video","url":"https://cdn.example/3"}]}"#,
        )
        .unwrap();
        let found: Vec<_> = several.iter().map(|file| (file.url.as_str(), file.hint)).collect();
        assert_eq!(found, [("https://cdn.example/2.jpg", Some(Hint::Photo)), ("https://cdn.example/3", Some(Hint::Video))], "in order, non-http link dropped");
        assert!(parse(r#"{"status":"picker","picker":[]}"#).is_err());

        let future: ApiItem = serde_json::from_str(r#"{"type":"hologram","url":"https://cdn.example/4"}"#).unwrap();
        assert_eq!(future.hint, Hint::Unknown);

        assert!(serde_json::from_str::<ApiResponse>(r#"{"status":"error","error":{"code":"error.api.fetch.fail"}}"#).is_ok());
        assert!(serde_json::from_str::<ApiResponse>(r#"{"status":"local-processing","type":"merge","tunnel":[]}"#).is_ok());
        assert!(serde_json::from_str::<ApiResponse>(r#"{"status":"surprise"}"#).is_err());
    }

    #[test]
    fn internal_links_are_pointed_back_at_the_instance() {
        let remote = endpoint("https://co.example/");
        for raw in ["http://cobalt:9000/tunnel?id=1", "http://127.0.0.1:9000/tunnel?id=1", "http://10.0.0.5/tunnel?id=1"] {
            assert_eq!(media_url(raw, &remote).unwrap().as_str(), "https://co.example/tunnel?id=1", "{raw}");
        }
        assert_eq!(media_url("https://cdn.example/v.mp4", &remote).unwrap().as_str(), "https://cdn.example/v.mp4");
        // our own loopback instance keeps its links
        let own = endpoint("http://127.0.0.1:9000/");
        assert_eq!(media_url("http://127.0.0.1:9000/tunnel?id=1", &own).unwrap().as_str(), "http://127.0.0.1:9000/tunnel?id=1");
        assert!(media_url("file:///etc/passwd", &own).is_none());
    }

    #[test]
    fn classifies_errors() {
        assert!(matches!(content_error("error.api.link.unsupported"), Some(Error::Unsupported)));
        assert!(matches!(content_error("error.api.content.too_long"), Some(Error::TooLarge)));
        assert!(matches!(content_error("error.api.content.post.private"), Some(Error::Private)));
        assert!(matches!(content_error("error.api.content.video.age"), Some(Error::AgeRestricted)));
        assert!(matches!(content_error("error.api.content.post.unavailable"), Some(Error::Unavailable(_))));
        assert!(content_error("error.api.fetch.fail").is_none());
        assert!(content_error("error.api.auth.key.invalid").is_none());
    }

    #[tokio::test]
    async fn budget_refuses_what_can_never_fit() {
        let budget = Budget::new(BUDGET_UNIT * 4);
        let held = budget.reserve(BUDGET_UNIT * 3).await.unwrap();
        assert!(matches!(budget.reserve(BUDGET_UNIT * 5).await, Err(Error::TooLarge)));
        drop(held);
        assert!(budget.reserve(BUDGET_UNIT * 4).await.is_ok());
    }

    #[test]
    fn cleans_file_names() {
        assert_eq!(clean_name("../a\\b\u{0}c.mp4"), "..abc.mp4");
    }
}
