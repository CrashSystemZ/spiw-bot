use std::{
    path::Path,
    sync::{Mutex, MutexGuard, PoisonError},
};

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::model::{FileRef, Platform, Post};

// `delivery_events` keeps the layout of the TypeScript bot so its stats carry over;
// that bot's other tables were caches and are dropped.
const SCHEMA: &str = "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS posts (
        key TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        url TEXT NOT NULL,
        caption TEXT,
        media TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);

    CREATE TABLE IF NOT EXISTS aliases (
        alias TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aliases_created ON aliases(created_at);

    CREATE TABLE IF NOT EXISTS delivery_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_kind TEXT NOT NULL,
        delivered_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_events_delivered_at ON delivery_events(delivered_at);

    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB NOT NULL);

    DROP TABLE IF EXISTS request_cache;
    DROP TABLE IF EXISTS query_aliases;
    DROP TABLE IF EXISTS metadata_cache;
    DROP TABLE IF EXISTS rehydrate_cache;
    DROP TABLE IF EXISTS ui_state;
";

const POST_COLUMNS: &str = "p.key, p.platform, p.url, p.caption, p.media";

/// All timestamps are unix milliseconds.
pub struct Db(Mutex<Connection>);

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = path.parent() {
            // if this fails, `open` below reports the real problem
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self(Mutex::new(conn)))
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        // a panic while holding the lock cannot leave sqlite in a broken state
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn post(&self, key: &str, not_before: i64) -> rusqlite::Result<Option<Post>> {
        let sql = format!("SELECT {POST_COLUMNS} FROM posts p WHERE p.key = ?1 AND p.created_at >= ?2");
        Ok(self.conn().query_row(&sql, params![key, not_before], read_post).optional()?.flatten())
    }

    pub fn post_by_alias(&self, alias: &str, not_before: i64) -> rusqlite::Result<Option<Post>> {
        let sql = format!(
            "SELECT {POST_COLUMNS} FROM aliases a JOIN posts p ON p.key = a.key WHERE a.alias = ?1 AND p.created_at >= ?2"
        );
        Ok(self.conn().query_row(&sql, params![alias, not_before], read_post).optional()?.flatten())
    }

    /// Inserts the post or refreshes its lifetime; uploaded media and caption survive.
    pub fn save_post(&self, key: &str, platform: Platform, url: &str, aliases: &[String], now: i64) -> rusqlite::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO posts (key, platform, url, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (key) DO UPDATE SET url = excluded.url, created_at = excluded.created_at",
            params![key, platform.as_str(), url, now],
        )?;
        for alias in aliases {
            tx.execute(
                "INSERT INTO aliases (alias, key, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (alias) DO UPDATE SET key = excluded.key, created_at = excluded.created_at",
                params![alias, key, now],
            )?;
        }
        tx.commit()
    }

    pub fn set_caption(&self, key: &str, caption: &str) -> rusqlite::Result<()> {
        self.conn().execute("UPDATE posts SET caption = ?2 WHERE key = ?1", params![key, caption]).map(drop)
    }

    pub fn set_media(&self, key: &str, media: Option<&[FileRef]>) -> rusqlite::Result<()> {
        let json = media.and_then(|m| serde_json::to_string(m).ok());
        self.conn().execute("UPDATE posts SET media = ?2 WHERE key = ?1", params![key, json]).map(drop)
    }

    pub fn record_deliveries(&self, kinds: &[&str], now: i64) -> rusqlite::Result<()> {
        let conn = self.conn();
        let mut insert = conn.prepare_cached("INSERT INTO delivery_events (media_kind, delivered_at) VALUES (?1, ?2)")?;
        kinds.iter().try_for_each(|kind| insert.execute(params![kind, now]).map(drop))
    }

    /// Deliveries since `since` and in total.
    pub fn stats(&self, since: i64) -> rusqlite::Result<(i64, i64)> {
        self.conn().query_row(
            "SELECT COALESCE(SUM(delivered_at >= ?1), 0), COUNT(*) FROM delivery_events",
            params![since],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    }

    pub fn cleanup(&self, before: i64) -> rusqlite::Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM posts WHERE created_at < ?1", params![before])?;
        conn.execute("DELETE FROM aliases WHERE created_at < ?1", params![before]).map(drop)
    }

    pub fn kv_get(&self, key: &str) -> rusqlite::Result<Option<Vec<u8>>> {
        self.conn().query_row("SELECT v FROM kv WHERE k = ?1", params![key], |row| row.get(0)).optional()
    }

    pub fn kv_set(&self, key: &str, value: &[u8]) -> rusqlite::Result<()> {
        self.conn().execute("INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v", params![key, value]).map(drop)
    }
}

/// `None` for a row of a platform this build no longer knows.
fn read_post(row: &Row<'_>) -> rusqlite::Result<Option<Post>> {
    let Some(platform) = Platform::parse(&row.get::<_, String>(1)?) else {
        return Ok(None);
    };
    let media: Option<String> = row.get(4)?;
    Ok(Some(Post {
        key: row.get(0)?,
        platform,
        url: row.get(2)?,
        caption: row.get(3)?,
        // an unreadable value, such as the single file older versions stored, is the same as no upload yet
        media: media.and_then(|json| serde_json::from_str(&json).ok()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::MediaKind;

    fn db() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        Db(Mutex::new(conn))
    }

    #[test]
    fn post_round_trip_and_expiry() {
        let db = db();
        db.save_post("k1", Platform::X, "https://x.com/a/status/1", &["a1".into(), "a2".into()], 1000).unwrap();

        let post = db.post_by_alias("a2", 0).unwrap().unwrap();
        assert_eq!((post.key.as_str(), post.platform, post.caption, post.media.is_none()), ("k1", Platform::X, None, true));
        assert!(db.post("k1", 1001).unwrap().is_none(), "older than the cutoff");
        assert!(db.post_by_alias("nope", 0).unwrap().is_none());

        let media = FileRef { kind: MediaKind::Video, id: 7, access_hash: -9, file_reference: vec![1, 2, 3] };
        db.set_media("k1", Some(std::slice::from_ref(&media))).unwrap();
        db.set_caption("k1", "hello").unwrap();
        // refreshing the post keeps what was already uploaded
        db.save_post("k1", Platform::X, "https://x.com/a/status/1", &[], 5000).unwrap();
        let post = db.post("k1", 4000).unwrap().unwrap();
        assert_eq!(post.caption.as_deref(), Some("hello"));
        assert_eq!(post.media.unwrap()[0].file_reference, [1, 2, 3]);

        let single = serde_json::to_string(&media).unwrap();
        db.conn().execute("UPDATE posts SET media = ?1", params![single]).unwrap();
        assert!(db.post("k1", 0).unwrap().unwrap().media.is_none(), "a file stored by an older version is uploaded again");

        db.set_media("k1", None).unwrap();
        assert!(db.post("k1", 0).unwrap().unwrap().media.is_none());

        db.cleanup(6000).unwrap();
        assert!(db.post("k1", 0).unwrap().is_none());
        assert!(db.post_by_alias("a1", 0).unwrap().is_none());
    }

    #[test]
    fn stats_and_kv() {
        let db = db();
        assert_eq!(db.stats(0).unwrap(), (0, 0));
        db.record_deliveries(&["video"], 100).unwrap();
        db.record_deliveries(&["video", "animation"], 900).unwrap();
        assert_eq!(db.stats(500).unwrap(), (2, 3));

        assert_eq!(db.kv_get("s").unwrap(), None);
        db.kv_set("s", b"one").unwrap();
        db.kv_set("s", b"two").unwrap();
        assert_eq!(db.kv_get("s").unwrap().as_deref(), Some(&b"two"[..]));
    }
}
