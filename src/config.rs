use std::{env, path::PathBuf, str::FromStr, time::Duration};

use reqwest::Url;

/// A cobalt instance we may ask to resolve links.
pub struct Endpoint {
    pub base: Url,
    /// Full `Authorization` header value, e.g. `Api-Key <uuid>`.
    pub auth: Option<String>,
}

impl Endpoint {
    pub fn name(&self) -> &str {
        self.base.host_str().unwrap_or("?")
    }
}

// No `Debug`: this holds the bot token and API keys.
pub struct Config {
    pub bot_token: String,
    pub api_id: i32,
    pub api_hash: String,
    pub db_path: PathBuf,
    /// Tried in order; the first one is our own instance.
    pub endpoints: Vec<Endpoint>,
    pub cobalt_timeout: Duration,
    pub resolve_timeout: Duration,
    pub post_ttl: Duration,
    pub max_jobs: usize,
    pub max_fetches: usize,
    pub budget_bytes: u64,
    pub max_item_bytes: u64,
    pub log_level: tracing::Level,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let mut endpoints = vec![endpoint(&required("COBALT_BASE_URL")?, var("COBALT_AUTHORIZATION"))?];
        // extra instances: `url` or `url|Api-Key <uuid>`, comma separated
        for entry in var("COBALT_EXTRA_ENDPOINTS").unwrap_or_default().split(',') {
            let (url, auth) = entry.split_once('|').unwrap_or((entry, ""));
            if !url.trim().is_empty() {
                endpoints.push(endpoint(url.trim(), Some(auth.trim().to_owned()).filter(|a| !a.is_empty()))?);
            }
        }

        Ok(Self {
            bot_token: required("BOT_TOKEN")?,
            api_id: required("TG_API_ID")?.parse().map_err(|_| "TG_API_ID must be a number")?,
            api_hash: required("TG_API_HASH")?,
            db_path: var("DB_PATH").unwrap_or_else(|| "data/spiw.sqlite".into()).into(),
            endpoints,
            cobalt_timeout: Duration::from_millis(positive("COBALT_REQUEST_TIMEOUT_MS", 8000)?),
            resolve_timeout: Duration::from_millis(positive("INLINE_RESOLVE_TIMEOUT_MS", 5000)?),
            post_ttl: Duration::from_secs(positive("REHYDRATE_TTL_SECONDS", 432_000)?),
            max_jobs: positive("MAX_CONCURRENT_JOBS", 32)?,
            max_fetches: positive("MAX_FETCHES_PER_JOB", 4)?,
            budget_bytes: positive("MEDIA_BUFFER_BUDGET_BYTES", 2 << 30)?,
            max_item_bytes: positive("MAX_MEDIA_ITEM_BYTES", 2 << 30)?,
            log_level: parsed("LOG_LEVEL", tracing::Level::INFO)?,
        })
    }
}

fn var(name: &str) -> Option<String> {
    env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn required(name: &str) -> Result<String, String> {
    var(name).ok_or_else(|| format!("{name} is not set"))
}

fn parsed<T: FromStr>(name: &str, default: T) -> Result<T, String> {
    var(name).map_or(Ok(default), |v| v.parse().map_err(|_| format!("{name} has an invalid value")))
}

fn positive<T: FromStr + PartialOrd + Default>(name: &str, default: T) -> Result<T, String> {
    let value = parsed(name, default)?;
    if value > T::default() { Ok(value) } else { Err(format!("{name} must be positive")) }
}

fn endpoint(url: &str, auth: Option<String>) -> Result<Endpoint, String> {
    match Url::parse(url) {
        // plain http would send the API key in the clear; fine only for an instance on our own network
        Ok(base) if base.scheme() == "https" || (base.scheme() == "http" && crate::net::is_internal(&base)) => Ok(Endpoint { base, auth }),
        Ok(_) => Err(format!("cobalt endpoint must use https: {url}")),
        Err(_) => Err(format!("invalid cobalt endpoint URL: {url}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_instances_must_use_https() {
        assert!(endpoint("https://cobalt.example.org/", None).is_ok());
        assert!(endpoint("http://127.0.0.1:9000", None).is_ok());
        assert!(endpoint("http://cobalt:9000/", None).is_ok());
        assert!(endpoint("http://cobalt.example.org/", None).is_err());
        assert!(endpoint("ftp://cobalt.example.org/", None).is_err());
        assert!(endpoint("not a url", None).is_err());
    }
}
