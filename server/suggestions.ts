import { db, getSetting, setSetting, type MediaType } from './db.js';
import { ensureTitles, getTitle, type TitleRef } from './titles.js';
import { findByImdb, MOVIE_CERTS, summarize, tmdbGet, tmdbType, TV_CERTS } from './tmdb.js';

export const SUGGESTIONS_REFRESH_MS = 24 * 3600_000;
export const SUGGESTIONS_SIZE = 50;
const MAX_SEEDS = 25;
const REC_TTL = 24 * 3600_000;

interface Seed {
  imdbId: string;
  mediaType: MediaType;
  at: number;
}

/** Recently watched titles: Stremio history plus the manual Watched list, newest first. */
export function watchedSeeds(): Seed[] {
  const rows = db()
    .prepare(
      `SELECT imdb_id, media_type, COALESCE(last_watched_at, 0) AS at FROM watch_history
       UNION ALL
       SELECT t.imdb_id, li.media_type, li.added_at AS at
       FROM list_items li JOIN lists l ON l.id = li.list_id
       JOIN titles t ON t.tmdb_id = li.tmdb_id AND t.media_type = li.media_type
       WHERE l.system_key = 'watched' AND t.imdb_id IS NOT NULL
       ORDER BY at DESC`,
    )
    .all() as { imdb_id: string; media_type: MediaType; at: number }[];
  const seen = new Set<string>();
  const out: Seed[] = [];
  for (const r of rows) {
    if (seen.has(r.imdb_id)) continue;
    seen.add(r.imdb_id);
    out.push({ imdbId: r.imdb_id, mediaType: r.media_type, at: r.at });
  }
  return out;
}

/** IMDb IDs that should never be suggested: anything watched or already in the Library. */
function excludedImdbIds(): Set<string> {
  const rows = db()
    .prepare(
      `SELECT imdb_id FROM watch_history
       UNION
       SELECT t.imdb_id FROM list_items li JOIN lists l ON l.id = li.list_id
       JOIN titles t ON t.tmdb_id = li.tmdb_id AND t.media_type = li.media_type
       WHERE l.system_key IN ('watched', 'library') AND t.imdb_id IS NOT NULL`,
    )
    .all() as { imdb_id: string }[];
  return new Set(rows.map((r) => r.imdb_id));
}

export function certCaps(): Record<MediaType, string | null> {
  return {
    movie: getSetting('suggestion_max_cert_movie'),
    series: getSetting('suggestion_max_cert_series'),
  };
}

export function setCertCaps(caps: Partial<Record<MediaType, string | null>>) {
  if (caps.movie !== undefined) setSetting('suggestion_max_cert_movie', caps.movie && MOVIE_CERTS.includes(caps.movie) ? caps.movie : null);
  if (caps.series !== undefined) setSetting('suggestion_max_cert_series', caps.series && TV_CERTS.includes(caps.series) ? caps.series : null);
}

/** With a cap set, only titles with a known certification at or below it pass. */
export function withinCap(cert: string | null, type: MediaType, cap: string | null): boolean {
  if (!cap) return true;
  const scale = type === 'movie' ? MOVIE_CERTS : TV_CERTS;
  const i = cert ? scale.indexOf(cert) : -1;
  return i >= 0 && i <= scale.indexOf(cap);
}

async function seedTmdbRef(seed: Seed): Promise<TitleRef | null> {
  const known = db()
    .prepare('SELECT tmdb_id, media_type FROM titles WHERE imdb_id = ? ORDER BY media_type = ? DESC LIMIT 1')
    .get(seed.imdbId, seed.mediaType) as { tmdb_id: number; media_type: MediaType } | undefined;
  if (known) return { tmdbId: known.tmdb_id, mediaType: known.media_type };
  const found = await findByImdb(seed.imdbId, seed.mediaType).catch(() => null);
  return found ? { tmdbId: found.tmdbId, mediaType: found.mediaType } : null;
}

let running: Promise<number> | null = null;

export function refreshSuggestions(): Promise<number> {
  running ??= doRefresh().finally(() => {
    running = null;
  });
  return running;
}

async function doRefresh(): Promise<number> {
  try {
    const seeds = watchedSeeds().slice(0, MAX_SEEDS);
    const excluded = excludedImdbIds();
    const caps = certCaps();

    // Score each recommended title by how many recent watches point to it, weighting newer watches
    // and higher-ranked recommendations more.
    const scores = new Map<string, { ref: TitleRef; score: number }>();
    for (const [i, seed] of seeds.entries()) {
      const ref = await seedTmdbRef(seed);
      if (!ref) continue;
      const recs = await tmdbGet(`/${tmdbType(ref.mediaType)}/${ref.tmdbId}/recommendations`, { page: 1 }, REC_TTL).catch(
        () => ({ results: [] }),
      );
      const seedWeight = 1 / (1 + i * 0.15);
      (recs.results ?? []).forEach((r: any, rank: number) => {
        const t = summarize(r, ref.mediaType);
        if (!t) return;
        const key = `${t.mediaType}:${t.tmdbId}`;
        const entry = scores.get(key) ?? { ref: { tmdbId: t.tmdbId, mediaType: t.mediaType }, score: 0 };
        entry.score += seedWeight * (1 - rank / 40);
        scores.set(key, entry);
      });
    }

    const picked: TitleRef[] = [];
    for (const type of ['movie', 'series'] as MediaType[]) {
      // Take extra candidates: some drop out once details show they're watched, capped, or have no IMDb ID.
      const candidates = [...scores.values()]
        .filter((s) => s.ref.mediaType === type)
        .sort((a, b) => b.score - a.score)
        .slice(0, SUGGESTIONS_SIZE * 2)
        .map((s) => s.ref);
      await ensureTitles(candidates);
      const keep = candidates.filter((r) => {
        const t = getTitle(r);
        return t?.imdb_id && !excluded.has(t.imdb_id) && withinCap(t.certification, type, caps[type]);
      });
      picked.push(...keep.slice(0, SUGGESTIONS_SIZE));
    }

    const d = db();
    const list = d.prepare(`SELECT id FROM lists WHERE system_key = 'suggestions'`).get() as { id: number };
    const insert = d.prepare(
      `INSERT OR IGNORE INTO list_items (list_id, tmdb_id, media_type, position, added_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    d.transaction(() => {
      d.prepare('DELETE FROM list_items WHERE list_id = ?').run(list.id);
      picked.forEach((r, i) => insert.run(list.id, r.tmdbId, r.mediaType, i, now));
    })();
    setSetting('suggestions_refreshed_at', String(now));
    setSetting('suggestions_seed_count', String(seeds.length));
    setSetting('suggestions_error', null);
    return picked.length;
  } catch (err: any) {
    setSetting('suggestions_error', err.message);
    throw err;
  }
}

export function suggestionsStale() {
  return Date.now() - Number(getSetting('suggestions_refreshed_at') ?? 0) > SUGGESTIONS_REFRESH_MS;
}

export function suggestionsStatus() {
  return {
    refreshedAt: Number(getSetting('suggestions_refreshed_at')) || null,
    seedCount: Number(getSetting('suggestions_seed_count')) || 0,
    error: getSetting('suggestions_error'),
    caps: certCaps(),
  };
}
