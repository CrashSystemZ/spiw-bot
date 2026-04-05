from __future__ import annotations

from pathlib import Path

import aiosqlite


async def init_database(db_path: Path) -> aiosqlite.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = await aiosqlite.connect(str(db_path))
    db.row_factory = aiosqlite.Row

    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA busy_timeout=5000")
    await db.execute("PRAGMA synchronous=NORMAL")
    await db.execute("PRAGMA cache_size=-24000")         

    await db.executescript("""
        CREATE TABLE IF NOT EXISTS media_cache (
            cache_key       TEXT PRIMARY KEY,
            platform        TEXT NOT NULL,
            items_json      TEXT NOT NULL,
            title           TEXT,
            description     TEXT,
            thumbnail_url   TEXT,
            source_url      TEXT,
            like_count      INTEGER,
            comment_count   INTEGER,
            created_at      REAL NOT NULL DEFAULT (unixepoch('now'))
        );

        CREATE TABLE IF NOT EXISTS query_aliases (
            alias_hash      TEXT PRIMARY KEY,
            cache_key       TEXT NOT NULL,
            FOREIGN KEY (cache_key) REFERENCES media_cache(cache_key)
        );

        CREATE INDEX IF NOT EXISTS idx_query_aliases_cache_key
            ON query_aliases(cache_key);

        CREATE INDEX IF NOT EXISTS idx_media_cache_created
            ON media_cache(created_at);
    """)

    await db.commit()

    for col, col_type in [("audio_file_id", "TEXT"), ("audio_duration", "REAL")]:
        try:
            await db.execute(f"ALTER TABLE media_cache ADD COLUMN {col} {col_type}")
        except Exception:
            pass
    await db.commit()

    return db
