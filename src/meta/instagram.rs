//! Instagram posts cobalt cannot read. Cobalt looks for a post's JSON in its embed page, and
//! Instagram puts a single photo there as plain HTML instead; for a hidden post it says nothing.

use std::time::Duration;

use reqwest::header::{ACCEPT, USER_AGENT};
use reqwest::{StatusCode, Url};

use super::{BROWSER_UA, HTML_ACCEPT, on_platform, read_capped};
use crate::model::Platform;

/// What Instagram shows a logged-out visitor in place of the post's media.
#[derive(Debug, PartialEq, Eq)]
pub enum Fallback {
    Photo(Url),
    Private,
    /// Kept from anyone whose age Instagram cannot check.
    AgeRestricted,
}

pub(super) async fn fallback(http: &reqwest::Client, id: &str, timeout: Duration) -> Option<Fallback> {
    // the id goes into URLs below
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return None;
    }
    if let Some((_, page)) = get(http, &format!("https://www.instagram.com/p/{id}/embed/captioned/"), timeout).await
        && let Some(url) = photo(&page, id)
    {
        return Some(Fallback::Photo(url));
    }
    let (status, body) = get(http, &format!("https://www.instagram.com/api/v1/oembed/?url=https://www.instagram.com/p/{id}/"), timeout).await?;
    gate(status, &body)
}

async fn get(http: &reqwest::Client, url: &str, timeout: Duration) -> Option<(StatusCode, String)> {
    let response = http
        .get(url)
        .header(USER_AGENT, BROWSER_UA)
        .header(ACCEPT, HTML_ACCEPT)
        // without it Instagram answers with its app shell instead of the embed
        .header("sec-fetch-site", "none")
        .timeout(timeout)
        .send()
        .await
        .ok()?;
    on_platform(response.url(), Platform::Instagram).ok()?;
    let status = response.status();
    Some((status, String::from_utf8_lossy(&read_capped(response).await.ok()?).into_owned()))
}

/// The largest rendition of a lone photo. A video or carousel embed shows only a still,
/// and those cobalt reads itself, so they are refused.
fn photo(html: &str, id: &str) -> Option<Url> {
    let lone_photo = html.contains(r#""isSidecar":false"#) && html.contains(r#""contextJSON":null"#) && !html.contains(&format!("/reel/{id}"));
    if !lone_photo {
        return None;
    }
    let tag = html.split(r#"<img class="EmbeddedMediaImage""#).nth(1)?.split('>').next()?;
    let attribute = |name: &str| tag.split(&format!(r#" {name}=""#)).nth(1)?.split('"').next();
    let largest = attribute("srcset").and_then(|set| {
        set.split(',')
            .filter_map(|candidate| {
                let (url, width) = candidate.trim().rsplit_once(' ')?;
                Some((width.strip_suffix('w')?.parse::<u32>().ok()?, url))
            })
            .max_by_key(|(width, _)| *width)
            .map(|(_, url)| url)
    });
    let url = Url::parse(&largest.or_else(|| attribute("src"))?.replace("&amp;", "&")).ok()?;
    (url.scheme() == "https").then_some(url)
}

/// Why oembed refuses a post to a logged-out visitor.
fn gate(status: StatusCode, body: &str) -> Option<Fallback> {
    if status == StatusCode::FORBIDDEN && body.contains("Private media") {
        Some(Fallback::Private)
    } else if body.contains(r#""message":"geoblock_required""#) && body.contains("certain audiences") {
        // Instagram's notice for a post it keeps from minors
        Some(Fallback::AgeRestricted)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INIT: &str = r#"["init",[],[{"isRichEmbed":false,"isSidecar":false,"isGuideEmbed":false,"isProfileEmbed":false,"contextJSON":null}]],"#;
    const IMG: &str = r#"<a class="EmbeddedMedia" href="https://www.instagram.com/p/Ab1_-/"><img class="EmbeddedMediaImage" alt="a &#064;b" src="https://cdn.example/s.jpg?a=1&amp;b=2" srcset="https://cdn.example/640.jpg?a=1&amp;b=2 640w,https://cdn.example/2250.jpg?a=1&amp;b=2 2250w,https://cdn.example/150.jpg 150w" /></a>"#;

    #[test]
    fn takes_the_largest_rendition_of_a_lone_photo() {
        let page = format!("{INIT}{IMG}");
        assert_eq!(photo(&page, "Ab1_-").unwrap().as_str(), "https://cdn.example/2250.jpg?a=1&b=2");
        let no_srcset = page.replace(" srcset=", " data-x=");
        assert_eq!(photo(&no_srcset, "Ab1_-").unwrap().as_str(), "https://cdn.example/s.jpg?a=1&b=2");
        assert!(photo(&page.replace("https://cdn", "http://cdn"), "Ab1_-").is_none());
    }

    #[test]
    fn leaves_videos_and_carousels_to_cobalt() {
        let carousel = format!("{}{IMG}", INIT.replace(r#""isSidecar":false"#, r#""isSidecar":true"#));
        assert!(photo(&carousel, "Ab1_-").is_none());
        let with_json = format!("{}{IMG}", INIT.replace(r#""contextJSON":null"#, r#""contextJSON":"{}""#));
        assert!(photo(&with_json, "Ab1_-").is_none());
        let reel = format!("{INIT}{}", IMG.replace("/p/Ab1_-/", "/reel/Ab1_-/"));
        assert!(photo(&reel, "Ab1_-").is_none());
        assert!(photo(INIT, "Ab1_-").is_none(), "removed post: no image");
    }

    #[test]
    fn tells_private_from_age_restricted() {
        assert_eq!(gate(StatusCode::FORBIDDEN, "Private media"), Some(Fallback::Private));
        let gated = r#"{"message":"geoblock_required","gating_type":"unappealable","title":"This content isn't available to everyone","description":"It can't be seen by certain audiences."}"#;
        assert_eq!(gate(StatusCode::BAD_REQUEST, gated), Some(Fallback::AgeRestricted));
        assert_eq!(gate(StatusCode::OK, r#"{"title":"Private media"}"#), None);
        assert_eq!(gate(StatusCode::NOT_FOUND, "No Media Match"), None);
    }

    #[tokio::test]
    async fn refuses_odd_ids_without_asking() {
        assert_eq!(fallback(&reqwest::Client::new(), "a/../b", Duration::from_millis(1)).await, None);
        assert_eq!(fallback(&reqwest::Client::new(), "", Duration::from_millis(1)).await, None);
    }
}
