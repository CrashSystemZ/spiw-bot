use std::fmt;

use grammers_client::InvocationError;

/// Why a post could not be delivered. The variant decides what the user sees;
/// the payload is for logs only.
#[derive(Debug)]
pub enum Error {
    Unsupported,
    TooLarge,
    LocalProcessing,
    Private,
    AgeRestricted,
    /// The post is gone from the cache, so there is nothing to retry.
    Expired,
    /// The media exists but could not be fetched right now.
    Unavailable(String),
    Telegram(InvocationError),
    Internal(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => f.write_str("link not supported"),
            Self::TooLarge => f.write_str("media too large"),
            Self::LocalProcessing => f.write_str("media requires local processing"),
            Self::Private => f.write_str("account is private"),
            Self::AgeRestricted => f.write_str("media is age-restricted"),
            Self::Expired => f.write_str("post expired"),
            Self::Unavailable(why) => write!(f, "media unavailable: {why}"),
            Self::Telegram(e) => write!(f, "telegram: {e}"),
            Self::Internal(why) => write!(f, "internal: {why}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<InvocationError> for Error {
    fn from(e: InvocationError) -> Self {
        Self::Telegram(e)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::Internal(format!("db: {e}"))
    }
}
