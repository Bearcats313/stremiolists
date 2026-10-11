import { config } from './config.js';
import { db, getSetting, type MediaType } from './db.js';

export const TTL = {
  details: 7 * 24 * 3600_000,
  search: 3600_000,
  trending: 6 * 3600_000,
  static: 7 * 24 * 3600_000,
};

export const IMAGE_BASE = 'https://image.tmdb.org/t/p';

export class TmdbError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function tmdbKey(): string {
  return getSetting('tmdb_api_key') || config.envTmdbApiKey;
}

export const tmdbType = (t: MediaType) => (t === 'movie' ? 'movie' : 'tv');
export const mediaType = (t: string): MediaType => (t === 'movie' ? 'movie' : 'series');

// TMDB allows ~40 req/s per IP; cap concurrency so bulk adds and imports stay well under it.
const MAX_CONCURRENT = 8;
let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

type Params = Record<string, string | number | undefined | null>;

/** GET a TMDB v3 endpoint, cached in SQLite for `ttl` ms. */
export async function tmdbGet<T = any>(endpoint: string, params: Params = {}, ttl = TTL.search): Promise<T> {
  const key = tmdbKey();
  if (!key) throw new TmdbError('TMDB API key is not configured', 500);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const cacheKey = `tmdb:${endpoint}?${qs}`;
  const now = Date.now();
  const cached = db().prepare('SELECT payload, expires_at FROM cache WHERE key = ?').get(cacheKey) as
    | { payload: string; expires_at: number }
    | undefined;
  if (cached && cached.expires_at > now) return JSON.parse(cached.payload);

  // v4 read access tokens are JWTs and go in a header; v3 keys go in the query string.
  const isBearer = key.includes('.');
  if (!isBearer) qs.set('api_key', key);
  const url = `${config.tmdbBaseUrl}${endpoint}?${qs}`;

  const res = await withSlot(() =>
    fetch(url, {
      headers: { accept: 'application/json', ...(isBearer ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new TmdbError(`TMDB ${endpoint} failed: ${res.status} ${body.slice(0, 200)}`, res.status);
  }
  const data = await res.json();
  db()
    .prepare(
      'INSERT INTO cache (key, payload, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at',
    )
    .run(cacheKey, JSON.stringify(data), now + ttl);
  return data as T;
}

export function purgeExpiredCache() {
  db().prepare('DELETE FROM cache WHERE expires_at < ?').run(Date.now());
}

/** Validate a key by calling a cheap endpoint without caching. */
export async function testTmdbKey(key: string): Promise<boolean> {
  const isBearer = key.includes('.');
  const url = `${config.tmdbBaseUrl}/configuration${isBearer ? '' : `?api_key=${encodeURIComponent(key)}`}`;
  try {
    const res = await fetch(url, {
      headers: isBearer ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- Result shaping ----------

export interface TitleSummary {
  tmdbId: number;
  mediaType: MediaType;
  name: string;
  year: number | null;
  posterPath: string | null;
  rating: number | null;
}

export function yearOf(date: string | undefined | null): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) && y > 0 ? y : null;
}

export function summarize(r: any, fallbackType?: MediaType): TitleSummary | null {
  const t: MediaType | null =
    r.media_type === 'movie' ? 'movie' : r.media_type === 'tv' ? 'series' : r.media_type ? null : (fallbackType ?? null);
  if (!t) return null;
  return {
    tmdbId: r.id,
    mediaType: t,
    name: r.title ?? r.name ?? '',
    year: yearOf(r.release_date ?? r.first_air_date),
    posterPath: r.poster_path ?? null,
    rating: typeof r.vote_average === 'number' && r.vote_count > 0 ? Math.round(r.vote_average * 10) / 10 : null,
  };
}

// ---------- Streaming services ----------

/** Services offered as filters. TMDB has several provider IDs for some services (ad tiers, rebrands). */
export const SERVICES: { name: string; providerIds: number[] }[] = [
  { name: 'Netflix', providerIds: [8, 1796] },
  { name: 'Disney+', providerIds: [337] },
  { name: 'Max', providerIds: [1899, 384] },
  { name: 'Prime Video', providerIds: [9, 119] },
  { name: 'Hulu', providerIds: [15] },
  { name: 'Apple TV+', providerIds: [350] },
  { name: 'Paramount+', providerIds: [531, 2303, 2616] },
  { name: 'Peacock', providerIds: [386, 387] },
];

export const MOVIE_CERTS = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
export const TV_CERTS = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];

// ---------- Discover ----------

export interface DiscoverFilters {
  genres?: number[];
  keywords?: number[];
  yearFrom?: number;
  yearTo?: number;
  certs?: string[];
  minRating?: number;
  minVotes?: number;
  services?: string[];
  sort?: string;
}

export function discoverParams(type: MediaType, f: DiscoverFilters, page: number): Params {
  const isMovie = type === 'movie';
  const dateField = isMovie ? 'primary_release_date' : 'first_air_date';
  const providerIds = (f.services ?? []).flatMap((s) => SERVICES.find((x) => x.name === s)?.providerIds ?? []);
  return {
    page,
    sort_by: f.sort || 'popularity.desc',
    include_adult: 'false',
    with_genres: f.genres?.length ? f.genres.join(',') : undefined,
    with_keywords: f.keywords?.length ? f.keywords.join('|') : undefined,
    [`${dateField}.gte`]: f.yearFrom ? `${f.yearFrom}-01-01` : undefined,
    [`${dateField}.lte`]: f.yearTo ? `${f.yearTo}-12-31` : undefined,
    certification_country: f.certs?.length ? 'US' : undefined,
    certification: f.certs?.length ? f.certs.join('|') : undefined,
    'vote_average.gte': f.minRating || undefined,
    'vote_count.gte': f.minVotes || undefined,
    with_watch_providers: providerIds.length ? providerIds.join('|') : undefined,
    watch_region: providerIds.length ? getSetting('region') || 'US' : undefined,
    with_watch_monetization_types: providerIds.length ? 'flatrate|free|ads' : undefined,
  };
}

// ---------- Details ----------

export interface TitleDetails {
  tmdbId: number;
  mediaType: MediaType;
  imdbId: string | null;
  name: string;
  year: number | null;
  posterPath: string | null;
  overview: string;
  certification: string | null;
  rating: number | null;
  genres: string[];
  runtime: number | null;
  providers: { name: string; logoPath: string | null }[];
}

export async function fetchDetails(type: MediaType, id: number): Promise<TitleDetails> {
  const isMovie = type === 'movie';
  const append = isMovie ? 'external_ids,release_dates,watch/providers' : 'external_ids,content_ratings,watch/providers';
  const d = await tmdbGet(`/${tmdbType(type)}/${id}`, { append_to_response: append }, TTL.details);
  const region = getSetting('region') || 'US';

  let certification: string | null = null;
  if (isMovie) {
    const rel = d.release_dates?.results?.find((r: any) => r.iso_3166_1 === region);
    // Prefer theatrical (3) then any non-empty certification.
    const dates: any[] = rel?.release_dates ?? [];
    certification =
      dates.find((x) => x.type === 3 && x.certification)?.certification ??
      dates.find((x) => x.certification)?.certification ??
      null;
  } else {
    certification = d.content_ratings?.results?.find((r: any) => r.iso_3166_1 === region)?.rating || null;
  }

  const prov = d['watch/providers']?.results?.[region];
  const providers = [...(prov?.flatrate ?? []), ...(prov?.ads ?? []), ...(prov?.free ?? [])]
    .filter((p: any, i: number, arr: any[]) => arr.findIndex((q) => q.provider_id === p.provider_id) === i)
    .map((p: any) => ({ name: p.provider_name, logoPath: p.logo_path ?? null }));

  const imdbId = (isMovie ? d.imdb_id : d.external_ids?.imdb_id) || d.external_ids?.imdb_id || null;

  return {
    tmdbId: d.id,
    mediaType: type,
    imdbId: imdbId && /^tt\d+$/.test(imdbId) ? imdbId : null,
    name: d.title ?? d.name ?? '',
    year: yearOf(d.release_date ?? d.first_air_date),
    posterPath: d.poster_path ?? null,
    overview: d.overview ?? '',
    certification,
    rating: d.vote_count > 0 ? Math.round(d.vote_average * 10) / 10 : null,
    genres: (d.genres ?? []).map((g: any) => g.name),
    runtime: isMovie ? (d.runtime ?? null) : (d.episode_run_time?.[0] ?? null),
    providers,
  };
}
