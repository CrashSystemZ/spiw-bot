//! Link handling per platform: whitelist, canonical URL, and (for X) the post text.
//!
//! Media itself is resolved by cobalt; this module never downloads media.

mod x;

use std::fmt::Write as _;
use std::time::{Duration, Instant};

use reqwest::Url;
use reqwest::header::{ACCEPT, USER_AGENT};

use crate::model::Platform;

const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const HTML_ACCEPT: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const MAX_BODY: usize = 2 * 1024 * 1024;

/// Result of canonicalising a user-supplied link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Normalized {
    pub platform: Platform,
    /// Canonical https URL of the post.
    pub url: String,
    /// Platform-side id of the post, when the URL carries one.
    pub media_id: Option<String>,
}

/// Post text, only fetched for platforms where `Platform::shows_caption()`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Details {
    pub title: Option<String>,
    pub caption: Option<String>,
}

#[derive(Debug)]
pub struct MetaError(pub String);

impl std::fmt::Display for MetaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MetaError {}

fn err(message: impl Into<String>) -> MetaError {
    MetaError(message.into())
}

/// Which platform handles this URL. No network. `None` means the link is not supported.
#[must_use]
pub fn platform_of(url: &Url) -> Option<Platform> {
    // Ports and credentials never appear in real links; refusing them keeps the canonical URL a plain `https://host/...`.
    if !matches!(url.scheme(), "http" | "https") || url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?;
    // The domain itself or a subdomain; a bare suffix match would also accept `eviltiktok.com`.
    let is = |domain: &str| host.strip_suffix(domain).is_some_and(|sub| sub.is_empty() || sub.ends_with('.'));
    if is("tiktok.com") {
        Some(Platform::Tiktok)
    } else if is("instagram.com") {
        Some(Platform::Instagram)
    } else if ["x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com", "fixupx.com", "fixvx.com"].into_iter().any(is) {
        // the last four are embed-fixing mirrors people paste instead of the real link
        Some(Platform::X)
    } else {
        None
    }
}

/// Canonicalise a supported link. May follow redirects for short links.
pub async fn normalize(http: &reqwest::Client, url: &Url, timeout: Duration) -> Result<Normalized, MetaError> {
    let platform = platform_of(url).ok_or_else(|| err("The URL is not supported"))?;
    let url = tidy(url);
    let (url, media_id) = match platform {
        Platform::Tiktok => tiktok(http, url, timeout).await?,
        Platform::Instagram => instagram(&url).ok_or_else(|| err("Only Instagram posts and Reels are supported"))?,
        Platform::X => x_status(&url).ok_or_else(|| err("Only X status links are supported"))?,
    };
    Ok(Normalized { platform, url, media_id: Some(media_id) })
}

/// Title and caption of a post. Only called when `post.platform.shows_caption()`.
pub async fn details(http: &reqwest::Client, post: &Normalized, timeout: Duration) -> Result<Details, MetaError> {
    match post.platform {
        Platform::X => x::details(http, post, timeout).await,
        Platform::Tiktok | Platform::Instagram => Ok(Details::default()),
    }
}

/// Force https, drop the fragment and trailing slashes.
fn tidy(url: &Url) -> Url {
    let mut url = url.clone();
    // Cannot fail: `platform_of` only lets http(s) through.
    let _ = url.set_scheme("https");
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    url
}

fn segments(url: &Url) -> Vec<&str> {
    url.path().split('/').filter(|segment| !segment.is_empty()).collect()
}

fn x_status(url: &Url) -> Option<(String, String)> {
    let segments = segments(url);
    let status = segments.iter().position(|segment| *segment == "status")?;
    let handle = segments.get(status.checked_sub(1)?)?;
    let id = segments.get(status + 1)?;
    Some((format!("https://x.com/{handle}/status/{id}"), (*id).to_owned()))
}

fn instagram(url: &Url) -> Option<(String, String)> {
    let segments = segments(url);
    let kind = match *segments.first()? {
        "p" => "p",
        "reel" | "reels" => "reel",
        _ => return None,
    };
    let id = segments.get(1)?;
    Some((format!("https://{}/{kind}/{id}", url.host_str()?), (*id).to_owned()))
}

async fn tiktok(http: &reqwest::Client, mut url: Url, timeout: Duration) -> Result<(String, String), MetaError> {
    let host = url.host_str().unwrap_or_default();
    let short_link = matches!(host.strip_prefix("www.").unwrap_or(host), "vm.tiktok.com" | "vt.tiktok.com") || url.path().starts_with("/t/");
    if short_link {
        url = tidy(&follow(http, url, Platform::Tiktok, timeout).await?);
    }

    let unsupported = || err("Only TikTok video and photo links are supported");
    let segments = segments(&url);
    let post = segments.iter().position(|segment| matches!(*segment, "video" | "photo")).ok_or_else(unsupported)?;
    let canonical_path = segments.get(..post + 2).ok_or_else(unsupported)?.join("/");
    let id = segments.get(post + 1).ok_or_else(unsupported)?;
    let host = url.host_str().ok_or_else(unsupported)?;

    let query: Vec<_> = url.query_pairs().collect();
    // `share_item_id` alone is not a story: every shared video carries it, next to the sharer's tracking ids
    let story = query.iter().any(|(key, value)| key == "story_uid" || (key == "story_type" && value == "1"));
    let canonical = if story {
        // A story is addressed by its query, so that is kept, minus share tracking.
        let query: Vec<_> = query
            .iter()
            .filter(|(key, _)| key != "feature" && key != "si")
            .map(|(key, value)| format!("{}={}", encode_component(key), encode_component(value)))
            .collect();
        format!("https://{host}{}?{}", url.path(), query.join("&"))
    } else {
        format!("https://{host}/{canonical_path}")
    };
    Ok((canonical, (*id).to_owned()))
}

/// JS `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// Where a short link ends up: asked with HEAD, and with GET when the HEAD request itself fails.
async fn follow(http: &reqwest::Client, url: Url, platform: Platform, timeout: Duration) -> Result<Url, MetaError> {
    let start = Instant::now();
    // Half the budget, so a host that hangs on HEAD still leaves time for the GET.
    let head = http.head(url.clone()).header(USER_AGENT, BROWSER_UA).timeout(timeout / 2).send().await;
    if let Ok(response) = head {
        on_platform(response.url(), platform)?;
        return Ok(response.url().clone());
    }
    let page = get_page(http, url, platform, timeout.saturating_sub(start.elapsed())).await?;
    Ok(page.url().clone())
}

/// GET with browser headers. Only a 2xx that is still on `platform` after redirects is returned.
async fn get_page(http: &reqwest::Client, url: Url, platform: Platform, timeout: Duration) -> Result<reqwest::Response, MetaError> {
    let response = http
        .get(url)
        .header(USER_AGENT, BROWSER_UA)
        .header(ACCEPT, HTML_ACCEPT)
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| err(error.to_string()))?;
    on_platform(response.url(), platform)?;
    if !response.status().is_success() {
        return Err(err(format!("The page responded with status {}", response.status().as_u16())));
    }
    Ok(response)
}

/// Links and redirects are attacker-controlled: nothing off-platform or non-https is trusted.
fn on_platform(url: &Url, platform: Platform) -> Result<(), MetaError> {
    if url.scheme() == "https" && platform_of(url) == Some(platform) {
        Ok(())
    } else {
        Err(err("The link leads outside the platform"))
    }
}

/// The response body, cut off at `MAX_BODY`.
async fn read_capped(mut response: reqwest::Response) -> Result<Vec<u8>, MetaError> {
    let mut body = Vec::new();
    while body.len() < MAX_BODY
        && let Some(chunk) = response.chunk().await.map_err(|error| err(error.to_string()))?
    {
        body.extend_from_slice(&chunk);
    }
    body.truncate(MAX_BODY);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform(url: &str) -> Option<Platform> {
        platform_of(&Url::parse(url).unwrap())
    }

    /// `expected` is the canonical URL and media id. Only for links that need no network.
    async fn check(url: &str, expected: Option<(&str, &str)>) {
        let http = reqwest::Client::new();
        let got = normalize(&http, &Url::parse(url).unwrap(), Duration::from_secs(1)).await.ok();
        if let Some(normalized) = &got {
            assert_eq!(Some(normalized.platform), platform(url), "{url}");
            // The caller re-normalizes stored canonical URLs and expects them back unchanged.
            let again = normalize(&http, &Url::parse(&normalized.url).unwrap(), Duration::from_secs(1)).await.ok();
            assert_eq!(again.as_ref(), Some(normalized), "{url}");
        }
        let got = got.as_ref().map(|normalized| (normalized.url.as_str(), normalized.media_id.as_deref().unwrap()));
        assert_eq!(got, expected, "{url}");
    }

    #[test]
    fn platform_of_accepts_each_platform_host() {
        for url in [
            "https://tiktok.com/@u/video/1",
            "https://www.tiktok.com/@u/video/1",
            "https://m.tiktok.com/v/1.html",
            "https://vm.tiktok.com/ZMabc/",
            "https://vt.tiktok.com/ZSabc/",
            "https://www.tiktok.com/t/ZTabc/",
            "http://WWW.TikTok.com/",
            "https://tiktok.com:443/",
        ] {
            assert_eq!(platform(url), Some(Platform::Tiktok), "{url}");
        }
        for url in ["https://instagram.com/p/a", "https://www.instagram.com/reel/a/", "http://m.instagram.com/"] {
            assert_eq!(platform(url), Some(Platform::Instagram), "{url}");
        }
        for url in [
            "https://x.com/u/status/1",
            "https://www.x.com/",
            "https://twitter.com/u/status/1",
            "https://mobile.twitter.com/u/status/1",
            "http://www.twitter.com/",
            "https://fxtwitter.com/u/status/1",
            "https://vxtwitter.com/u/status/1",
            "https://fixupx.com/u/status/1",
        ] {
            assert_eq!(platform(url), Some(Platform::X), "{url}");
        }
    }

    #[test]
    fn platform_of_rejects_everything_else() {
        for url in [
            "https://example.com/@u/video/1",
            "https://threads.net/@u/post/a",
            "https://tiktok.com.evil.example/@u/video/1",
            "https://eviltiktok.com/@u/video/1",
            "https://tiktok.com.",
            "https://notinstagram.com/p/a",
            "https://instagram.com.evil.example/p/a",
            "https://netflix.com/u/status/1",
            "https://notfxtwitter.com/u/status/1",
            "https://x.com.evil.example/u/status/1",
            "https://evil.example/x.com/u/status/1",
            "https://evil.example/?u=https://x.com/u/status/1",
            "https://x.com@evil.example/u/status/1",
            "https://user@x.com/u/status/1",
            "https://user:pw@tiktok.com/@u/video/1",
            "https://tiktok.com:8443/@u/video/1",
            "ftp://tiktok.com/@u/video/1",
            "mailto:u@x.com",
        ] {
            assert_eq!(platform(url), None, "{url}");
        }
    }

    #[tokio::test]
    async fn normalize_x() {
        let jack = Some(("https://x.com/jack/status/20", "20"));
        check("https://x.com/jack/status/20", jack).await;
        check("https://twitter.com/jack/status/20?s=20&t=abc#frag", jack).await;
        check("http://mobile.twitter.com/jack/status/20/", jack).await;
        check("https://www.x.com/jack/status/20/photo/1", jack).await;
        check("https://x.com/i/web/status/20", Some(("https://x.com/web/status/20", "20"))).await;
        // Path segments are compared and copied as written: still percent-encoded, case-sensitive.
        check("https://x.com/J%C3%A4ck/status/20%2F1?x=1", Some(("https://x.com/J%C3%A4ck/status/20%2F1", "20%2F1"))).await;
        check("https://X.COM/Jack/Status/20", None).await;
        check("https://x.com/jack", None).await;
        check("https://x.com/jack/status", None).await;
        check("https://x.com/status/20", None).await;
    }

    #[tokio::test]
    async fn normalize_instagram() {
        check("https://www.instagram.com/p/Cx_-1/?igshid=abc#frag", Some(("https://www.instagram.com/p/Cx_-1", "Cx_-1"))).await;
        check("http://instagram.com/reel/Cx1", Some(("https://instagram.com/reel/Cx1", "Cx1"))).await;
        check("https://www.instagram.com/reels/Cx1/", Some(("https://www.instagram.com/reel/Cx1", "Cx1"))).await;
        check("https://www.instagram.com/p/Cx1/extra", Some(("https://www.instagram.com/p/Cx1", "Cx1"))).await;
        check("https://www.instagram.com/p/", None).await;
        check("https://www.instagram.com/someone/", None).await;
        check("https://www.instagram.com/stories/someone/1", None).await;
        check("https://www.instagram.com/someone/p/Cx1", None).await;
    }

    #[tokio::test]
    async fn normalize_tiktok_full_links() {
        check(
            "https://www.tiktok.com/@user/video/7300000000000000000?is_from_webapp=1&sender_device=pc#frag",
            Some(("https://www.tiktok.com/@user/video/7300000000000000000", "7300000000000000000")),
        )
        .await;
        check("http://m.tiktok.com/@user/photo/73/", Some(("https://m.tiktok.com/@user/photo/73", "73"))).await;
        check("https://tiktok.com//@user//video/73/extra", Some(("https://tiktok.com/@user/video/73", "73"))).await;
        check("https://www.tiktok.com/@us%20er/video/73?a=1", Some(("https://www.tiktok.com/@us%20er/video/73", "73"))).await;
        check("https://www.tiktok.com/@user", None).await;
        check("https://www.tiktok.com/@user/video/", None).await;
        check("https://m.tiktok.com/v/73.html", None).await;
    }

    #[tokio::test]
    async fn normalize_tiktok_story_keeps_its_query() {
        check(
            "https://www.tiktok.com/@user/video/73/?story_type=1&feature=share&u=a+b%26c&si=x&e=%C3%A9!#frag",
            Some(("https://www.tiktok.com/@user/video/73?story_type=1&u=a%20b%26c&e=%C3%A9!", "73")),
        )
        .await;
        check("https://www.tiktok.com/@user/photo/73?share_item_id=9&u_code=abc&_d=xyz", Some(("https://www.tiktok.com/@user/photo/73", "73"))).await;
        check("https://www.tiktok.com/@user/video/73/more?story_uid=5&si=x", Some(("https://www.tiktok.com/@user/video/73/more?story_uid=5", "73"))).await;
        check("https://www.tiktok.com/@user/video/73?story_type=2", Some(("https://www.tiktok.com/@user/video/73", "73"))).await;
    }

    #[tokio::test]
    async fn normalize_rejects_other_sites() {
        check("https://eviltiktok.com/@user/video/73", None).await;
        check("https://example.com/jack/status/20", None).await;
    }

    #[tokio::test]
    async fn details_of_other_platforms_are_empty() {
        let post = Normalized { platform: Platform::Tiktok, url: "https://www.tiktok.com/@user/video/73".to_owned(), media_id: Some("73".to_owned()) };
        assert_eq!(details(&reqwest::Client::new(), &post, Duration::from_secs(1)).await.unwrap(), Details::default());
    }

    #[test]
    fn redirect_target_must_be_https_on_the_same_platform() {
        let check = |url: &str| on_platform(&Url::parse(url).unwrap(), Platform::Tiktok).is_ok();
        assert!(check("https://www.tiktok.com/@user/video/73"));
        assert!(!check("http://www.tiktok.com/@user/video/73"));
        assert!(!check("https://www.instagram.com/p/a"));
        assert!(!check("https://tiktok.com.evil.example/@user/video/73"));
        assert!(!check("https://127.0.0.1/@user/video/73"));
    }

    #[test]
    fn encode_component_matches_js() {
        assert_eq!(encode_component("aZ09-_.!~*'()"), "aZ09-_.!~*'()");
        assert_eq!(encode_component("a b&c=d/é+"), "a%20b%26c%3Dd%2F%C3%A9%2B");
    }
}
