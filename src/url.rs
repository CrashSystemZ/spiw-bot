use reqwest::Url;

/// First link in an inline query, upgraded to https. `None` when nothing in it looks like a link.
pub fn parse_input(input: &str) -> Option<Url> {
    let text = input.trim();
    let lower = text.to_ascii_lowercase();
    let start = [lower.find("https://"), lower.find("http://")].into_iter().flatten().min().unwrap_or(0);
    let candidate = text.get(start..)?.split_whitespace().next()?;
    let candidate = candidate.trim_end_matches(['.', ',', ';', '!', '?', ')', '>', ']']);

    let mut url = Url::parse(candidate)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .or_else(|| {
            // bare `tiktok.com/...` without a scheme
            let domain = candidate.split('/').next()?;
            if !domain.contains('.') || domain.contains(':') {
                return None;
            }
            Url::parse(&format!("https://{candidate}")).ok()
        })?;
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }
    url.host_str().is_some().then_some(url)
}

/// Cache alias of a link: the same post pasted with or without a trailing slash or fragment.
pub fn alias(url: &Url) -> String {
    let mut url = url.clone();
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    url.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(input: &str) -> Option<String> {
        parse_input(input).map(String::from)
    }

    #[test]
    fn extracts_and_upgrades_links() {
        assert_eq!(parsed("https://x.com/a/status/1").as_deref(), Some("https://x.com/a/status/1"));
        assert_eq!(parsed("  http://x.com/a  ").as_deref(), Some("https://x.com/a"));
        assert_eq!(parsed("look: HTTPS://X.com/a/status/1). nice").as_deref(), Some("https://x.com/a/status/1"));
        assert_eq!(parsed("tiktok.com/@u/video/1").as_deref(), Some("https://tiktok.com/@u/video/1"));
    }

    #[test]
    fn rejects_non_links() {
        for input in ["", "   ", "hello", "hello world", "javascript:alert(1)", "file:///etc/passwd", "host:22/x", "ftp://a.b/c"] {
            assert_eq!(parsed(input), None, "{input}");
        }
    }

    #[test]
    fn alias_ignores_trailing_slash_and_fragment() {
        let a = alias(&Url::parse("https://X.com/a/status/1/?s=20#frag").unwrap());
        assert_eq!(a, "https://x.com/a/status/1?s=20");
        assert_eq!(alias(&Url::parse("https://x.com/").unwrap()), "https://x.com/");
    }
}
