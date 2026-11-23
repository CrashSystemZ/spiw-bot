//! Instagram, read the way a logged-out visitor sees it. The post page carries the post as JSON:
//! every file of it, including lone photos and photos set to music that cobalt cannot read, and
//! the age gate when there is one. oembed tells a private post apart.

use std::time::Duration;

use reqwest::header::{ACCEPT, USER_AGENT};
use reqwest::{StatusCode, Url};
use serde_json::Value;

use super::{BROWSER_UA, HTML_ACCEPT, on_platform, read_capped};
use crate::model::Platform;

#[derive(Debug, PartialEq, Eq)]
pub enum Found {
    /// The post's files in order, each with whether it is a video.
    Media(Vec<(Url, bool)>),
    Private,
    /// Kept from anyone whose age Instagram cannot check.
    AgeRestricted,
}

/// The post as its page shows it. `None` when the page has nothing usable.
pub(super) async fn media(http: &reqwest::Client, id: &str, timeout: Duration) -> Option<Found> {
    let (_, page) = get(http, &format!("https://www.instagram.com/p/{id}/"), timeout).await?;
    parse(&page, id)
}

/// Why a post nobody could read is hidden, if Instagram says.
pub(super) async fn gate(http: &reqwest::Client, id: &str, timeout: Duration) -> Option<Found> {
    let (status, body) = get(http, &format!("https://www.instagram.com/api/v1/oembed/?url=https://www.instagram.com/p/{id}/"), timeout).await?;
    hidden(status, &body)
}

fn hidden(status: StatusCode, body: &str) -> Option<Found> {
    if status == StatusCode::FORBIDDEN && body.contains("Private media") {
        Some(Found::Private)
    } else if body.contains(r#""message":"geoblock_required""#) && body.contains("certain audiences") {
        // the notice Instagram shows logged-out visitors in place of a post it keeps from minors
        Some(Found::AgeRestricted)
    } else {
        None
    }
}

async fn get(http: &reqwest::Client, url: &str, timeout: Duration) -> Option<(StatusCode, String)> {
    let response = http
        .get(url)
        .header(USER_AGENT, BROWSER_UA)
        .header(ACCEPT, HTML_ACCEPT)
        // without it Instagram answers with its bare app shell
        .header("sec-fetch-site", "none")
        .timeout(timeout)
        .send()
        .await
        .ok()?;
    on_platform(response.url(), Platform::Instagram).ok()?;
    let status = response.status();
    Some((status, String::from_utf8_lossy(&read_capped(response).await.ok()?).into_owned()))
}

fn parse(page: &str, id: &str) -> Option<Found> {
    let media = page
        .split(r#"<script type="application/json""#)
        .skip(1)
        .filter_map(|script| script.split_once('>')?.1.split("</script>").next())
        .filter(|json| json.contains("xig_polaris_media"))
        .filter_map(|json| serde_json::from_str::<Value>(json).ok())
        .find_map(|data| find(&data, "xig_polaris_media").filter(|media| media["code"] == id).cloned())?;
    let post = &media["if_not_gated_logged_out"];
    if post.is_null() {
        return (!media["gating_ruling"].is_null()).then_some(Found::AgeRestricted);
    }
    let items = match post["carousel_media"].as_array() {
        Some(items) => items.iter().collect(),
        None => vec![post],
    };
    let files = items.into_iter().map(file).collect::<Option<Vec<_>>>()?;
    (!files.is_empty()).then_some(Found::Media(files))
}

/// The best rendition of one file: the first, as Instagram lists them best first.
fn file(item: &Value) -> Option<(Url, bool)> {
    let (url, video) = match item["video_versions"][0]["url"].as_str() {
        Some(url) => (url, true),
        None => (item["image_versions2"]["candidates"][0]["url"].as_str()?, false),
    };
    let url = Url::parse(url).ok().filter(|url| url.scheme() == "https")?;
    Some((url, video))
}

/// The value under the first `key` met, searching depth first.
fn find<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key).or_else(|| map.values().find_map(|value| find(value, key))),
        Value::Array(items) => items.iter().find_map(|value| find(value, key)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(media: &str) -> String {
        format!(
            r#"<html><script type="application/json" data-sjs>{{"require":[["x"]]}}</script><script type="application/json" data-sjs>{{"require":[[0,{{"__bbox":{{"result":{{"data":{{"xig_polaris_media":{media}}}}}}}}}]]}}</script></html>"#
        )
    }

    fn urls(found: Option<Found>) -> Vec<(String, bool)> {
        let Some(Found::Media(files)) = found else { panic!("no media: {found:?}") };
        files.into_iter().map(|(url, video)| (url.to_string(), video)).collect()
    }

    #[test]
    fn reads_photos_videos_and_carousels() {
        let photo = page(r#"{"code":"Ab1","if_not_gated_logged_out":{"image_versions2":{"candidates":[{"url":"https://cdn.example/big.webp"},{"url":"https://cdn.example/small.webp"}]}}}"#);
        assert_eq!(urls(parse(&photo, "Ab1")), [("https://cdn.example/big.webp".into(), false)]);

        // a photo set to music is a video
        let video = page(r#"{"code":"Ab1","if_not_gated_logged_out":{"video_versions":[{"type":101,"url":"https://cdn.example/v.mp4"}],"image_versions2":{"candidates":[{"url":"https://cdn.example/cover.jpg"}]}}}"#);
        assert_eq!(urls(parse(&video, "Ab1")), [("https://cdn.example/v.mp4".into(), true)]);

        let carousel = page(
            r#"{"code":"Ab1","if_not_gated_logged_out":{"carousel_media":[
                {"image_versions2":{"candidates":[{"url":"https://cdn.example/1.jpg"}]}},
                {"video_versions":[{"url":"https://cdn.example/2.mp4"}],"image_versions2":{"candidates":[{"url":"https://cdn.example/2.jpg"}]}}]}}"#,
        );
        assert_eq!(urls(parse(&carousel, "Ab1")), [("https://cdn.example/1.jpg".into(), false), ("https://cdn.example/2.mp4".into(), true)]);
    }

    #[test]
    fn tells_an_age_gate_from_a_useless_page() {
        let gated = page(r#"{"code":"Ab1","if_not_gated_logged_out":null,"gating_ruling":{"title":"Age-restricted content"}}"#);
        assert_eq!(parse(&gated, "Ab1"), Some(Found::AgeRestricted));
        let other_post = page(r#"{"code":"Zz9","if_not_gated_logged_out":{"image_versions2":{"candidates":[{"url":"https://cdn.example/1.jpg"}]}}}"#);
        assert_eq!(parse(&other_post, "Ab1"), None);
        let insecure = page(r#"{"code":"Ab1","if_not_gated_logged_out":{"image_versions2":{"candidates":[{"url":"http://cdn.example/1.jpg"}]}}}"#);
        assert_eq!(parse(&insecure, "Ab1"), None);
        assert_eq!(parse(&page(r#"{"code":"Ab1","if_not_gated_logged_out":null}"#), "Ab1"), None);
        assert_eq!(parse("<html>app shell</html>", "Ab1"), None);
    }

    #[test]
    fn tells_private_from_age_restricted() {
        assert_eq!(hidden(StatusCode::FORBIDDEN, "Private media"), Some(Found::Private));
        let gated = r#"{"message":"geoblock_required","gating_type":"unappealable","title":"This content isn't available to everyone","description":"It can't be seen by certain audiences."}"#;
        assert_eq!(hidden(StatusCode::BAD_REQUEST, gated), Some(Found::AgeRestricted));
        assert_eq!(hidden(StatusCode::OK, r#"{"title":"Private media"}"#), None);
        assert_eq!(hidden(StatusCode::NOT_FOUND, "No Media Match"), None);
    }
}
