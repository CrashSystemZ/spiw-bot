//! Post text for X: the syndication API first, the page's own meta tags when that fails.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use reqwest::Url;
use reqwest::header::{ACCEPT, USER_AGENT};
use serde_json::Value;

use super::{Details, MetaError, Normalized, err, get_page, on_platform, read_capped};
use crate::model::Platform;

const SYNDICATION_HOST: &str = "cdn.syndication.twimg.com";

pub(super) async fn details(http: &reqwest::Client, post: &Normalized, timeout: Duration) -> Result<Details, MetaError> {
    let start = Instant::now();
    if let Some(id) = post.media_id.as_deref()
        && let Some(tweet) = syndication_tweet(http, id, timeout).await
    {
        let caption = tweet.get("text").and_then(Value::as_str).and_then(collapse_caption);
        return Ok(Details { title: caption.as_deref().map(title_of), caption });
    }

    let url = Url::parse(&post.url).map_err(|error| err(error.to_string()))?;
    on_platform(&url, Platform::X)?;
    let page = get_page(http, url, Platform::X, timeout.saturating_sub(start.elapsed())).await?;
    Ok(html_details(&String::from_utf8_lossy(&read_capped(page).await?)))
}

/// The tweet as the syndication API describes it. `None` on any failure: the page is tried next.
async fn syndication_tweet(http: &reqwest::Client, id: &str, timeout: Duration) -> Option<Value> {
    let token = syndication_token(id);
    let url = Url::parse_with_params(&format!("https://{SYNDICATION_HOST}/tweet-result"), [("id", id), ("lang", "en"), ("token", &token)]).ok()?;
    let response = http
        .get(url)
        .header(USER_AGENT, "Mozilla/5.0")
        .header(ACCEPT, "application/json,text/plain;q=0.9,*/*;q=0.8")
        .timeout(timeout)
        .send()
        .await
        .ok()?;
    let landed = response.url();
    if !response.status().is_success() || landed.scheme() != "https" || landed.host_str() != Some(SYNDICATION_HOST) {
        return None;
    }
    let tweet: Value = serde_json::from_slice(&read_capped(response).await.ok()?).ok()?;
    tweet.as_object().is_some_and(|fields| !fields.is_empty()).then_some(tweet)
}

/// The letters of JS `(id / 1e15 * Math.PI).toString(36)`, or `"1"` when there are none.
fn syndication_token(id: &str) -> String {
    let value = id.parse::<f64>().unwrap_or(f64::NAN) / 1e15 * std::f64::consts::PI;
    let letters = if value.is_finite() && value > 0.0 { base36_letters(value) } else { String::new() };
    if letters.is_empty() { "1".to_owned() } else { letters }
}

/// The letter digits of V8's `Number.prototype.toString(36)` for a positive finite `value`.
/// A step-by-step port of V8's `DoubleToRadixCString`, so the token is the one Node sends.
// shortcut: integer digits differ from V8 from 2^53 up (ids of 31+ digits); tweet ids are 64-bit, so never.
#[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "every cast value is a digit in 0..36")]
fn base36_letters(value: f64) -> String {
    let mut integer = value.floor();
    let mut fraction = value - integer;
    // Fractional digits are produced only up to the precision of the input.
    let mut delta = (0.5 * (value.next_up() - value)).max(f64::from_bits(1));
    let mut fraction_digits: Vec<u8> = Vec::new();
    if fraction >= delta {
        loop {
            fraction *= 36.0;
            delta *= 36.0;
            let digit = fraction as u8;
            fraction_digits.push(digit);
            fraction -= f64::from(digit);
            // Round half to even, carrying through trailing `z`s and, past the point, into the integer.
            if (fraction > 0.5 || (fraction >= 0.5 && digit % 2 == 1)) && fraction + delta > 1.0 {
                loop {
                    match fraction_digits.pop() {
                        Some(last) if last < 35 => {
                            fraction_digits.push(last + 1);
                            break;
                        }
                        Some(_) => {}
                        None => {
                            integer += 1.0;
                            break;
                        }
                    }
                }
                break;
            }
            if fraction < delta {
                break;
            }
        }
    }

    let mut digits: Vec<u8> = Vec::new();
    loop {
        let remainder = integer % 36.0;
        digits.push(remainder as u8);
        integer = (integer - remainder) / 36.0;
        if integer <= 0.0 {
            break;
        }
    }
    digits.reverse();
    digits.extend(fraction_digits);
    digits.into_iter().filter(|digit| (10..36).contains(digit)).map(|digit| char::from(b'a' + digit - 10)).collect()
}

/// Title and caption from the post page's `<meta>` tags, the title falling back to `<title>`.
fn html_details(html: &str) -> Details {
    // Same byte offsets as `html`, so tags can be found case-insensitively.
    let lower = html.to_ascii_lowercase();
    let metas = meta_values(html, &lower);
    let meta = |keys: &[&str]| {
        let (_, content) = keys.iter().find_map(|key| metas.iter().find(|(name, _)| name == key))?;
        Some(collapse_spaces(&decode_entities(content)))
    };
    let caption = meta(&["og:description", "twitter:description"]).as_deref().and_then(collapse_caption);
    let title = caption
        .clone()
        .or_else(|| meta(&["og:title", "twitter:title"]))
        .or_else(|| title_tag(html, &lower))
        .map(|text| title_of(&text))
        .filter(|title| !title.is_empty());
    Details { title, caption }
}

/// `(key, content)` of every `<meta>` that has both, in document order.
fn meta_values(html: &str, lower: &str) -> Vec<(String, String)> {
    let mut values = Vec::new();
    let mut from = 0;
    while let Some((inside, end)) = open_tag(html, lower, "<meta", from) {
        from = end;
        let attributes = attributes(inside);
        let first = |names: &[&str]| names.iter().find_map(|name| attributes.get(*name)).map_or("", |value| value.trim());
        let key = first(&["property", "name", "itemprop"]).to_lowercase();
        let content = first(&["content", "value"]);
        if !key.is_empty() && !content.is_empty() {
            values.push((key, content.to_owned()));
        }
    }
    values
}

/// The first `<title>`'s text.
fn title_tag(html: &str, lower: &str) -> Option<String> {
    let (_, start) = open_tag(html, lower, "<title", 0)?;
    let end = start + lower.get(start..)?.find("</title>")?;
    let text = html.get(start..end)?;
    (!text.is_empty()).then(|| plain_text(text))
}

/// The next `<name ...>` at or after `from` (`name` is lower-case and includes the `<`):
/// what is between the name and the first `>`, and the offset just past that `>`.
fn open_tag<'a>(html: &'a str, lower: &str, name: &str, mut from: usize) -> Option<(&'a str, usize)> {
    loop {
        from += lower.get(from..)?.find(name)? + name.len();
        let tail = html.get(from..)?;
        // `<metadata>` is not a `<meta>`.
        if !tail.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
            let end = tail.find('>')?;
            return Some((tail.get(..end)?, from + end + 1));
        }
    }
}

/// Attributes of a tag, given the text after its name: lower-cased name to entity-decoded value.
/// Values may be double-quoted, single-quoted or bare; a repeated name keeps its last value.
fn attributes(mut rest: &str) -> HashMap<String, String> {
    let name_end = |c: char| c.is_whitespace() || matches!(c, '=' | '/' | '>');
    let mut attributes = HashMap::new();
    loop {
        rest = rest.trim_start_matches(name_end);
        let Some((name, after)) = rest.split_at_checked(rest.find(name_end).unwrap_or(rest.len())) else { break };
        if name.is_empty() {
            break;
        }
        rest = after;
        let mut value = "";
        if let Some(raw) = after.trim_start().strip_prefix('=').map(str::trim_start) {
            let quoted = ['"', '\''].into_iter().find_map(|quote| raw.strip_prefix(quote)?.split_once(quote));
            let bare = || {
                let end = raw.find(|c: char| c.is_whitespace() || "\"'=<>`".contains(c)).unwrap_or(raw.len());
                raw.split_at_checked(end).filter(|(value, _)| !value.is_empty())
            };
            if let Some((found, tail)) = quoted.or_else(bare) {
                value = found;
                rest = tail;
            }
        }
        attributes.insert(name.to_lowercase(), decode_entities(value));
    }
    attributes
}

/// Tags removed, entities decoded, whitespace collapsed; `None` when nothing is left.
fn collapse_caption(text: &str) -> Option<String> {
    Some(plain_text(text)).filter(|text| !text.is_empty())
}

fn plain_text(text: &str) -> String {
    collapse_spaces(&decode_entities(&strip_tags(text)))
}

fn collapse_spaces(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Every `<...>` with something inside becomes a space.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((before, after)) = rest.split_once('<') {
        out.push_str(before);
        match after.split_once('>') {
            Some((inside, tail)) if !inside.is_empty() => {
                out.push(' ');
                rest = tail;
            }
            Some(_) => {
                out.push('<');
                rest = after;
            }
            // No `>` left at all: stop here rather than rescan the tail for every further `<`.
            None => {
                out.push('<');
                rest = after;
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Decodes `&amp;` `&lt;` `&gt;` `&quot;` and numeric references, in one pass.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((before, after)) = rest.split_once('&') {
        out.push_str(before);
        // `#x10ffff` is the longest reference worth decoding; looking no further keeps the scan linear.
        let decoded = after.bytes().take(9).position(|byte| byte == b';').and_then(|end| Some((entity(after.get(..end)?)?, after.get(end + 1..)?)));
        if let Some((character, tail)) = decoded {
            out.push(character);
            rest = tail;
        } else {
            out.push('&');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

fn entity(name: &str) -> Option<char> {
    match name.to_ascii_lowercase().as_str() {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        numeric => {
            let digits = numeric.strip_prefix('#')?;
            let code = match digits.strip_prefix('x') {
                Some(hex) => u32::from_str_radix(hex, 16),
                None => digits.parse(),
            };
            char::from_u32(code.ok()?)
        }
    }
}

/// The first 96 UTF-16 units of `text` (JS `slice(0, 96)`), never cutting a character in half.
fn title_of(text: &str) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= 96
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The shape of a live `tweet-result` response (2026-11), with the text swapped for one that needs cleaning:
    // the API escapes `&`, `<` and `>`, and keeps newlines.
    const TWEET: &str = r#"{"__typename":"Tweet","conversation_count":19260,"created_at":"2006-03-21T20:50:14.000Z",
        "display_text_range":[0,61],"edit_control":{"edit_tweet_ids":["20"],"editable_until_msecs":"1142976014000",
        "edits_remaining":"5","is_edit_eligible":true},"entities":{},"favorite_count":324738,"id_str":"20",
        "isEdited":false,"isStaleEdit":false,"lang":"en","news_action_type":"conversation",
        "text":"Fish &amp; chips &lt;3\n\nsecond   line &#39;quoted&#39; &amp;lt; https://t.co/abc",
        "user":{"id_str":"12","is_blue_verified":true,"name":"jack","profile_image_shape":"Circle",
        "profile_image_url_https":"https://pbs.twimg.com/profile_images/1/a_normal.jpg","screen_name":"jack","verified":false}}"#;

    // What the API answers for a deleted post: an object, but with no top-level `text`.
    const TOMBSTONE: &str = r#"{"__typename":"TweetTombstone","tombstone":{"text":{"entities":[],"rtl":false,
        "text":"This Post was deleted by the Post author. Learn more"}}}"#;

    fn tweet_details(json: &str) -> (Option<String>, Option<String>) {
        let caption = serde_json::from_str::<Value>(json).unwrap().get("text").and_then(Value::as_str).and_then(collapse_caption);
        (caption.as_deref().map(title_of), caption)
    }

    #[test]
    fn text_from_syndication_payload() {
        let text = "Fish & chips <3 second line 'quoted' &lt; https://t.co/abc";
        assert_eq!(tweet_details(TWEET), (Some(text.to_owned()), Some(text.to_owned())));
        assert_eq!(tweet_details(TOMBSTONE), (None, None));
        assert_eq!(tweet_details(r#"{"text": " \n "}"#), (None, None));
        assert_eq!(tweet_details(r#"{"text": 5}"#), (None, None));

        let long = tweet_details(&format!(r#"{{"text": "{}"}}"#, "word ".repeat(40)));
        assert_eq!(long.0.unwrap(), format!("{}w", "word ".repeat(19)));
        assert_eq!(long.1.unwrap().len(), 199);
    }

    #[test]
    fn title_is_the_first_96_utf16_units() {
        assert_eq!(title_of("short"), "short");
        assert_eq!(title_of(&"a".repeat(97)), "a".repeat(96));
        // An astral character is two units: 48 fit, and a 95-unit prefix leaves no room for one.
        assert_eq!(title_of(&"😀".repeat(49)), "😀".repeat(48));
        assert_eq!(title_of(&format!("{}😀", "a".repeat(95))), "a".repeat(95));
    }

    #[test]
    fn token_matches_node() {
        // Expected values printed by Node 26: ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0\.|[^a-z]+)/g, "")
        for (id, token) in NODE_TOKENS {
            assert_eq!(syndication_token(id), *token, "{id}");
        }
        for id in ["", "abc", "-5", "0", "inf", "NaN", "1e999"] {
            assert_eq!(syndication_token(id), "1", "{id}");
        }
    }

    const NODE_TOKENS: &[(&str, &str)] = &[
        ("20", "dqaxwd"),
        ("1629307668568633344", "ymctgwzxo"),
        ("1", "bhiayfn"),
        ("999", "uqoxsuzm"),
        ("0.5", "qrhpjb"),
        ("1000000000000000", "iabpf"),
        ("9007199254740993", "saoujnxas"),
        ("18446744073709551615", "pslqoslc"),
        // Rounding carries: through trailing `z`s, and all the way into the integer part (leaving no letters).
        ("318309886183790", "zzzzzzzzzs"),
        ("636619772367581", "zzzzzzzzzw"),
        ("318309886183791", "1"),
    ];

    #[test]
    fn text_helpers() {
        assert_eq!(strip_tags("a <b>bold</b> <> 1 < 2"), "a  bold  <> 1 < 2");
        assert_eq!(decode_entities("&AMP; &lt;&gt; &quot;&#39;&#x1F600;&#X41; &amp;lt; &nope; &#xD800; & &"), "& <> \"'😀A &lt; &nope; &#xD800; & &");
        assert_eq!(collapse_spaces(" a \n\t b\u{a0}c "), "a b c");
    }

    #[test]
    fn details_from_page_meta() {
        let html = r#"<!DOCTYPE html><html><head>
            <metadata property="og:title" content="not a meta tag">
            <META content="Jack on X" property="OG:Title" />
            <meta name=twitter:title content='ignored: og wins'>
            <meta property="og:description" content="">
            <meta property="og:description" content="  &quot;just setting up&#10;my twttr&quot; &amp;amp; more ">
            <title>Fallback</title></head></html>"#;
        assert_eq!(
            html_details(html),
            Details { title: Some("\"just setting up my twttr\" & more".to_owned()), caption: Some("\"just setting up my twttr\" & more".to_owned()) }
        );
    }

    #[test]
    fn details_title_fallbacks() {
        let only_title = html_details("<meta name='twitter:title' content='Jack on X'><title>ignored</title>");
        assert_eq!(only_title, Details { title: Some("Jack on X".to_owned()), caption: None });

        let from_tag = html_details("<html><TITLE lang=en>\n Jack <b>on</b> X &amp; co </Title><meta property=og:image content=x>");
        assert_eq!(from_tag, Details { title: Some("Jack on X & co".to_owned()), caption: None });

        let twitter_description = html_details("<meta name=\"twitter:description\" content=\"hello\"><meta property=\"og:title\" content=\"Jack\">");
        assert_eq!(twitter_description, Details { title: Some("hello".to_owned()), caption: Some("hello".to_owned()) });

        assert_eq!(html_details("<html><body>nothing <meta <title"), Details::default());
    }
}
