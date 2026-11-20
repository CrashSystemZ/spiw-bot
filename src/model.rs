use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Tiktok,
    Instagram,
    X,
}

impl Platform {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Tiktok => "tiktok",
            Self::Instagram => "instagram",
            Self::X => "x",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "tiktok" => Some(Self::Tiktok),
            "instagram" => Some(Self::Instagram),
            "x" => Some(Self::X),
            _ => None,
        }
    }

    /// Caption is part of the post on X; on video platforms it is noise.
    pub const fn shows_caption(self) -> bool {
        matches!(self, Self::X)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Photo,
    Video,
    Animation,
    Audio,
    Document,
}

/// A file already uploaded to Telegram. Re-sending it costs one API call and no bytes.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileRef {
    pub kind: MediaKind,
    pub id: i64,
    pub access_hash: i64,
    pub file_reference: Vec<u8>,
}

/// Everything needed to deliver a post, as stored in the database.
#[derive(Clone, Debug)]
pub struct Post {
    /// 32 hex chars; doubles as the inline result id and the callback payload.
    pub key: String,
    pub platform: Platform,
    /// Canonical URL: handed to cobalt and shown as the source link.
    pub url: String,
    /// Ready-to-send caption. `None` = not fetched yet, empty = the post has no text.
    pub caption: Option<String>,
    /// The post's files on Telegram, in order, once they have been uploaded.
    pub media: Option<Vec<FileRef>>,
}

/// Stable id of a post. Platform is mixed in so numeric ids of different platforms never collide.
pub fn post_key(platform: Platform, id: &str) -> String {
    let digest = Sha256::new()
        .chain_update(platform.as_str())
        .chain_update(":")
        .chain_update(id)
        .finalize();
    hex(&digest[..16])
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable_and_platform_scoped() {
        let a = post_key(Platform::Tiktok, "123");
        assert_eq!(a.len(), 32);
        assert_eq!(a, post_key(Platform::Tiktok, "123"));
        assert_ne!(a, post_key(Platform::X, "123"));
    }
}
