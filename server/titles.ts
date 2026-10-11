import { db, type MediaType } from './db.js';
import { fetchDetails, TTL, type TitleDetails } from './tmdb.js';

export interface TitleRef {
  tmdbId: number;
  mediaType: MediaType;
}

export interface TitleRow {
  tmdb_id: number;
  media_type: MediaType;
  imdb_id: string | null;
  imdb_id_manual: number;
  name: string;
  year: number | null;
  poster_path: string | null;
  overview: string | null;
  certification: string | null;
  tmdb_rating: number | null;
  genres: string | null;
  cached_at: number;
}

export function upsertTitle(d: TitleDetails) {
  db()
    .prepare(
      `INSERT INTO titles (tmdb_id, media_type, imdb_id, name, year, poster_path, overview, certification, tmdb_rating, genres, cached_at)
       VALUES (@tmdbId, @mediaType, @imdbId, @name, @year, @posterPath, @overview, @certification, @rating, @genres, @cachedAt)
       ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
         imdb_id = CASE WHEN titles.imdb_id_manual = 1 THEN titles.imdb_id ELSE excluded.imdb_id END,
         name = excluded.name, year = excluded.year, poster_path = excluded.poster_path,
         overview = excluded.overview, certification = excluded.certification,
         tmdb_rating = excluded.tmdb_rating, genres = excluded.genres, cached_at = excluded.cached_at`,
    )
    .run({ ...d, genres: JSON.stringify(d.genres), cachedAt: Date.now() });
}

export function getTitle(ref: TitleRef): TitleRow | undefined {
  return db()
    .prepare('SELECT * FROM titles WHERE tmdb_id = ? AND media_type = ?')
    .get(ref.tmdbId, ref.mediaType) as TitleRow | undefined;
}

/** Make sure every title has a fresh row in `titles`. Returns refs that could not be fetched. */
export async function ensureTitles(refs: TitleRef[]): Promise<TitleRef[]> {
  const stale = refs.filter((r) => {
    const row = getTitle(r);
    return !row || Date.now() - row.cached_at > TTL.details;
  });
  const failed: TitleRef[] = [];
  await Promise.all(
    stale.map(async (r) => {
      try {
        upsertTitle(await fetchDetails(r.mediaType, r.tmdbId));
      } catch {
        // Keep an existing stale row if TMDB is unreachable; only a missing row is a failure.
        if (!getTitle(r)) failed.push(r);
      }
    }),
  );
  return failed;
}

export function setManualImdbId(ref: TitleRef, imdbId: string | null) {
  db()
    .prepare('UPDATE titles SET imdb_id = ?, imdb_id_manual = ? WHERE tmdb_id = ? AND media_type = ?')
    .run(imdbId, imdbId ? 1 : 0, ref.tmdbId, ref.mediaType);
}

/** Map of "type:id" -> list names that contain the title, for poster badges. */
export function listMembership(refs: TitleRef[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!refs.length) return out;
  const stmt = db().prepare(
    `SELECT l.name FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE li.tmdb_id = ? AND li.media_type = ? AND li.hidden = 0 ORDER BY l.name`,
  );
  for (const r of refs) {
    const names = (stmt.all(r.tmdbId, r.mediaType) as { name: string }[]).map((x) => x.name);
    if (names.length) out.set(`${r.mediaType}:${r.tmdbId}`, names);
  }
  return out;
}

/** Insert a minimal row (e.g. from an import file) when TMDB can't be reached. Existing rows win. */
export function insertStub(ref: TitleRef & { imdbId: string | null; name: string | null; year: number | null }) {
  db()
    .prepare(
      `INSERT OR IGNORE INTO titles (tmdb_id, media_type, imdb_id, name, year, cached_at) VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(ref.tmdbId, ref.mediaType, ref.imdbId, ref.name ?? `TMDB ${ref.tmdbId}`, ref.year);
}
