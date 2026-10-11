import { db, getSetting, setSetting, type MediaType } from './db.js';
import { getList, ListError, type ListRow } from './lists.js';
import { ensureTitles, type TitleRef } from './titles.js';
import { discoverParams, MOVIE_CERTS, SERVICES, summarize, tmdbGet, TV_CERTS, type DiscoverFilters } from './tmdb.js';

export const SMART_REFRESH_MS = 24 * 3600_000;

export interface SmartQuery {
  type: MediaType;
  genres: { id: number; name: string }[];
  keywords: { id: number; name: string }[];
  yearFrom?: number;
  yearTo?: number;
  certs: string[];
  minRating?: number;
  minVotes?: number;
  services: string[];
}

const idNames = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter((x) => Number.isInteger(x?.id) && x.id > 0)
        .map((x) => ({ id: x.id as number, name: String(x.name ?? x.id) }))
        .slice(0, 20)
    : [];
const optNum = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v) || undefined);

export function parseSmartQuery(v: any): SmartQuery {
  const type: MediaType = v?.type === 'series' ? 'series' : 'movie';
  const certs = (Array.isArray(v?.certs) ? v.certs : []).filter((c: string) =>
    (type === 'movie' ? MOVIE_CERTS : TV_CERTS).includes(c),
  );
  const services = (Array.isArray(v?.services) ? v.services : []).filter((s: string) => SERVICES.some((x) => x.name === s));
  const q: SmartQuery = {
    type,
    genres: idNames(v?.genres),
    keywords: idNames(v?.keywords),
    yearFrom: optNum(v?.yearFrom),
    yearTo: optNum(v?.yearTo),
    certs,
    minRating: optNum(v?.minRating),
    minVotes: optNum(v?.minVotes),
    services,
  };
  const hasFilter =
    q.genres.length || q.keywords.length || q.certs.length || q.services.length || q.yearFrom || q.yearTo || q.minRating || q.minVotes;
  if (!hasFilter) throw new ListError('Pick at least one filter before saving a smart list');
  return q;
}

function toFilters(q: SmartQuery): DiscoverFilters {
  return {
    genres: q.genres.map((g) => g.id),
    keywords: q.keywords.map((k) => k.id),
    yearFrom: q.yearFrom,
    yearTo: q.yearTo,
    certs: q.certs,
    minRating: q.minRating,
    minVotes: q.minVotes,
    services: q.services,
  };
}

export async function refreshSmartList(l: ListRow) {
  if (l.kind !== 'smart' || !l.smart_query) throw new ListError('Not a smart list');
  const q = parseSmartQuery(JSON.parse(l.smart_query));
  const limit = l.smart_limit ?? 50;
  const d = db();
  const hidden = new Set(
    (d.prepare('SELECT tmdb_id FROM list_items WHERE list_id = ? AND hidden = 1').all(l.id) as { tmdb_id: number }[]).map(
      (r) => r.tmdb_id,
    ),
  );

  // Hidden titles don't count toward the cap, so keep paging until enough visible ones are found.
  const refs: TitleRef[] = [];
  const seen = new Set<number>();
  for (let page = 1; refs.length < limit && page <= 25; page++) {
    const res = await tmdbGet(`/discover/${q.type === 'movie' ? 'movie' : 'tv'}`, discoverParams(q.type, toFilters(q), page));
    for (const r of res.results ?? []) {
      const t = summarize(r, q.type);
      if (!t || seen.has(t.tmdbId) || hidden.has(t.tmdbId)) continue;
      seen.add(t.tmdbId);
      refs.push(t);
      if (refs.length >= limit) break;
    }
    if (page >= (res.total_pages ?? 1)) break;
  }

  const failed = new Set((await ensureTitles(refs)).map((r) => r.tmdbId));
  const keep = refs.filter((r) => !failed.has(r.tmdbId));
  const now = Date.now();
  const insert = d.prepare(
    `INSERT OR IGNORE INTO list_items (list_id, tmdb_id, media_type, position, added_at) VALUES (?, ?, ?, ?, ?)`,
  );
  d.transaction(() => {
    d.prepare('DELETE FROM list_items WHERE list_id = ? AND hidden = 0').run(l.id);
    keep.forEach((r, i) => insert.run(l.id, r.tmdbId, r.mediaType, i, now));
  })();
  setSetting(`smart_refreshed_at:${l.id}`, String(now));
  return keep.length;
}

export function smartRefreshedAt(id: number): number | null {
  const v = getSetting(`smart_refreshed_at:${id}`);
  return v ? Number(v) : null;
}

export async function refreshStaleSmartLists(log: (msg: string, err?: unknown) => void) {
  const lists = db().prepare(`SELECT * FROM lists WHERE kind = 'smart'`).all() as ListRow[];
  for (const l of lists) {
    if (Date.now() - (smartRefreshedAt(l.id) ?? 0) < SMART_REFRESH_MS) continue;
    try {
      await refreshSmartList(l);
    } catch (err) {
      log(`Smart list ${l.name} failed to refresh`, err);
    }
  }
}

/** Hide or unhide titles in a smart list. Hidden titles stay out on later refreshes. */
export function setHidden(listId: number, refs: TitleRef[], hidden: boolean) {
  const l = getList(listId);
  if (l.kind !== 'smart') throw new ListError('Only smart lists can hide titles; remove them instead');
  const d = db();
  const upsert = d.prepare(
    `INSERT INTO list_items (list_id, tmdb_id, media_type, position, added_at, hidden) VALUES (?, ?, ?, 1000000, ?, ?)
     ON CONFLICT(list_id, tmdb_id, media_type) DO UPDATE SET hidden = excluded.hidden`,
  );
  const del = d.prepare('DELETE FROM list_items WHERE list_id = ? AND tmdb_id = ? AND media_type = ?');
  d.transaction(() => {
    for (const r of refs) {
      // Unhiding drops the row; the next refresh puts the title back where TMDB ranks it.
      if (hidden) upsert.run(listId, r.tmdbId, r.mediaType, Date.now(), 1);
      else del.run(listId, r.tmdbId, r.mediaType);
    }
  })();
}
