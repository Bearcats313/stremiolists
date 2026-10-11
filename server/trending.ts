import { db, getSetting, setSetting, type MediaType } from './db.js';
import type { ItemRow } from './lists.js';
import { ensureTitles, type TitleRef } from './titles.js';
import { discoverParams, SERVICES, summarize, tmdbGet, type TitleSummary } from './tmdb.js';

export const TRENDING_SIZE = 100;
export const TRENDING_REFRESH_MS = 6 * 3600_000;
const TYPES: MediaType[] = ['movie', 'series'];

export function enabledServices(): string[] {
  const raw = getSetting('enabled_services');
  if (!raw) return SERVICES.map((s) => s.name);
  try {
    const names = JSON.parse(raw) as string[];
    return SERVICES.map((s) => s.name).filter((n) => names.includes(n));
  } catch {
    return SERVICES.map((s) => s.name);
  }
}

export function setEnabledServices(names: string[]) {
  const valid = SERVICES.map((s) => s.name).filter((n) => names.includes(n));
  setSetting('enabled_services', JSON.stringify(valid));
}

/** "All" plus each enabled service, in the order shown in Stremio's filter dropdown. */
export function trendingOptions(): string[] {
  return ['All', ...enabledServices()];
}

/**
 * Most popular titles this week on the given services (US), via TMDB discover filtered by watch provider.
 * TMDB's popularity score is driven by recent activity, so this tracks what's trending on each service.
 */
async function fetchRanking(type: MediaType, services: string[]): Promise<TitleSummary[]> {
  const out: TitleSummary[] = [];
  const seen = new Set<number>();
  for (let page = 1; out.length < TRENDING_SIZE && page <= 10; page++) {
    const res = await tmdbGet(
      `/discover/${type === 'movie' ? 'movie' : 'tv'}`,
      discoverParams(type, { services, minVotes: 10 }, page),
    );
    for (const r of res.results ?? []) {
      const t = summarize(r, type);
      if (t && !seen.has(t.tmdbId)) {
        seen.add(t.tmdbId);
        out.push(t);
      }
    }
    if (page >= (res.total_pages ?? 1)) break;
  }
  return out.slice(0, TRENDING_SIZE);
}

let running: Promise<void> | null = null;

export function refreshTrending(): Promise<void> {
  running ??= doRefresh().finally(() => {
    running = null;
  });
  return running;
}

async function doRefresh() {
  const services = enabledServices();
  const rankings: { service: string; type: MediaType; titles: TitleSummary[] }[] = [];
  for (const type of TYPES) {
    if (services.length) rankings.push({ service: 'All', type, titles: await fetchRanking(type, services) });
    for (const s of services) rankings.push({ service: s, type, titles: await fetchRanking(type, [s]) });
  }

  const refs = new Map<string, TitleRef>();
  for (const r of rankings) for (const t of r.titles) refs.set(`${t.mediaType}:${t.tmdbId}`, t);
  await ensureTitles([...refs.values()]);

  const d = db();
  const insert = d.prepare('INSERT OR IGNORE INTO trending_items (service, media_type, position, tmdb_id) VALUES (?, ?, ?, ?)');
  d.transaction(() => {
    d.prepare('DELETE FROM trending_items').run();
    for (const r of rankings) r.titles.forEach((t, i) => insert.run(r.service, r.type, i, t.tmdbId));
  })();
  setSetting('trending_refreshed_at', String(Date.now()));
}

export function trendingStale() {
  return Date.now() - Number(getSetting('trending_refreshed_at') ?? 0) > TRENDING_REFRESH_MS;
}

export function trendingItems(
  service: string,
  opts: { mediaType?: MediaType; requireImdb?: boolean; limit?: number; offset?: number } = {},
): ItemRow[] {
  const where = ['ti.service = ?'];
  const args: (string | number)[] = [service];
  if (opts.mediaType) {
    where.push('ti.media_type = ?');
    args.push(opts.mediaType);
  }
  if (opts.requireImdb) where.push('t.imdb_id IS NOT NULL');
  let sql = `SELECT ti.tmdb_id, ti.media_type, ti.position, 0 AS added_at, t.imdb_id, t.name, t.year,
                    t.poster_path, t.overview, t.certification, t.tmdb_rating
             FROM trending_items ti LEFT JOIN titles t ON t.tmdb_id = ti.tmdb_id AND t.media_type = ti.media_type
             WHERE ${where.join(' AND ')} ORDER BY ti.media_type, ti.position`;
  if (opts.limit !== undefined) {
    sql += ' LIMIT ? OFFSET ?';
    args.push(opts.limit, opts.offset ?? 0);
  }
  return db().prepare(sql).all(...args) as ItemRow[];
}
