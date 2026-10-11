import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;
export type MediaType = 'movie' | 'series';

let instance: DB | null = null;

export function db(): DB {
  if (!instance) throw new Error('Database not initialised');
  return instance;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS titles (
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'series')),
  imdb_id TEXT,
  imdb_id_manual INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  year INTEGER,
  poster_path TEXT,
  overview TEXT,
  certification TEXT,
  tmdb_rating REAL,
  genres TEXT,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, media_type)
);

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'smart', 'system')),
  system_key TEXT UNIQUE,
  sort_mode TEXT NOT NULL DEFAULT 'manual',
  show_on_home INTEGER NOT NULL DEFAULT 1,
  season_start TEXT,
  season_end TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  smart_query TEXT,
  smart_limit INTEGER,
  position INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS list_items (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (list_id, tmdb_id, media_type)
);
CREATE INDEX IF NOT EXISTS list_items_title ON list_items (tmdb_id, media_type);

CREATE TABLE IF NOT EXISTS watch_history (
  imdb_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  last_watched_at INTEGER,
  source TEXT NOT NULL CHECK (source IN ('stremio', 'manual')),
  PRIMARY KEY (imdb_id, source)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trending_items (
  service TEXT NOT NULL,
  media_type TEXT NOT NULL,
  position INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  PRIMARY KEY (service, media_type, tmdb_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

const SYSTEM_LISTS: { key: string; slug: string; name: string }[] = [
  { key: 'library', slug: 'library', name: 'Library' },
  { key: 'trending', slug: 'trending', name: 'Trending' },
  { key: 'suggestions', slug: 'suggestions', name: 'Suggestions' },
  { key: 'watched', slug: 'watched', name: 'Watched' },
];

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.exec(SCHEMA);
  migrate(d);

  const insert = d.prepare(
    `INSERT OR IGNORE INTO lists (slug, name, kind, system_key, created_at)
     VALUES (?, ?, 'system', ?, ?)`,
  );
  for (const l of SYSTEM_LISTS) insert.run(l.slug, l.name, l.key, Date.now());
  // New lists (including system lists on first run) start at the end of the row order.
  d.prepare(
    `UPDATE lists SET position = (SELECT COALESCE(MAX(position), -1) + 1 FROM lists) + id WHERE position IS NULL`,
  ).run();

  instance = d;
  if (!getSetting('addon_token')) setSetting('addon_token', newToken());
  if (!getSetting('region')) setSetting('region', 'US');
  return d;
}

/** Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to existing databases. */
function migrate(d: DB) {
  const cols = new Set((d.pragma('table_info(lists)') as { name: string }[]).map((c) => c.name));
  if (!cols.has('position')) {
    d.exec('ALTER TABLE lists ADD COLUMN position INTEGER');
    // Keep the order existing installs already see: Library, Trending, Suggestions, then alphabetical.
    const ids = d
      .prepare(
        `SELECT id FROM lists ORDER BY
           CASE system_key WHEN 'library' THEN 0 WHEN 'trending' THEN 1 WHEN 'suggestions' THEN 2 WHEN 'watched' THEN 9 ELSE 5 END,
           name COLLATE NOCASE`,
      )
      .all() as { id: number }[];
    const upd = d.prepare('UPDATE lists SET position = ? WHERE id = ?');
    ids.forEach((r, i) => upd.run(i, r.id));
  }
}

export function closeDb() {
  instance?.close();
  instance = null;
}

export function newToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

export function getSetting(key: string): string | null {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null) {
  db()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}
