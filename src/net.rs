//! HTTP plumbing. Everything a third party can point us at goes through
//! `public_client`, which refuses to talk to private or loopback addresses.

use std::{
    net::{IpAddr, Ipv4Addr},
    sync::Arc,
    time::Duration,
};

use reqwest::{
    Client, Response, Url,
    dns::{Addrs, Name, Resolve, Resolving},
    redirect::Policy,
};

const USER_AGENT: &str = concat!("spiw-bot/", env!("CARGO_PKG_VERSION"), " (+https://github.com/CrashSystemZ/spiw-bot)");

pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map_or_else(
            || {
                let head = ip.segments()[0];
                // fc00::/7 unique local, fe80::/10 link local
                !(ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || head & 0xfe00 == 0xfc00 || head & 0xffc0 == 0xfe80)
            },
            is_public_v4,
        ),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || a >= 240
        || (a == 100 && b & 0xc0 == 64) // 100.64.0.0/10 carrier NAT, used by tailscale
        || (a == 198 && b & 0xfe == 18)) // 198.18.0.0/15 benchmarking
}

/// Host that can only mean "this machine or its private network".
pub fn is_internal(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => !is_public(ip.into()),
        Some(url::Host::Ipv6(ip)) => !is_public(ip.into()),
        Some(url::Host::Domain(name)) => {
            !name.contains('.') || [".localhost", ".local", ".internal"].iter().any(|tld| name.ends_with(tld))
        }
        None => true,
    }
}

/// Drops private addresses from DNS answers, so a public-looking name cannot lead inside.
struct PublicDns;

impl Resolve for PublicDns {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addrs: Vec<_> = tokio::net::lookup_host((name.as_str(), 0)).await?.filter(|a| is_public(a.ip())).collect();
            if addrs.is_empty() {
                return Err("host has no public address".into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

fn builder() -> reqwest::ClientBuilder {
    Client::builder().user_agent(USER_AGENT).connect_timeout(Duration::from_secs(10)).read_timeout(Duration::from_secs(30))
}

/// For URLs we did not choose ourselves: pages of supported platforms and media links.
/// Names are filtered at resolution and redirects by the policy; a caller passing an
/// IP-literal URL of its own must check it with `is_internal` first.
pub fn public_client() -> reqwest::Result<Client> {
    let redirects = Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else if !matches!(attempt.url().scheme(), "http" | "https") || is_internal(attempt.url()) {
            attempt.error("redirect to a non-public address")
        } else {
            attempt.follow()
        }
    });
    builder().redirect(redirects).dns_resolver(Arc::new(PublicDns)).build()
}

/// For the cobalt instances from our own config, which may live on loopback.
/// No redirects: an instance must not be able to bounce an authenticated request elsewhere.
pub fn endpoint_client() -> reqwest::Result<Client> {
    builder().redirect(Policy::none()).build()
}

/// Reads a response body, giving up once it exceeds `max` bytes.
pub async fn read_capped(mut response: Response, max: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if body.len() + chunk.len() > max {
            return Err(format!("response body exceeds {max} bytes"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_addresses() {
        for ip in ["8.8.8.8", "149.154.167.50", "2001:4860:4860::8888"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "127.0.0.1", "10.1.2.3", "172.21.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
            "255.255.255.255", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn classifies_hosts() {
        for url in ["http://127.0.0.1:9000/tunnel", "http://cobalt:9000/", "http://localhost/", "http://[::1]/", "http://a.internal/", "http://10.0.0.1/"] {
            assert!(is_internal(&Url::parse(url).unwrap()), "{url}");
        }
        for url in ["https://example.com/", "https://1.1.1.1/"] {
            assert!(!is_internal(&Url::parse(url).unwrap()), "{url}");
        }
    }
}
