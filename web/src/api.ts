export type MediaType = 'movie' | 'series';

export interface Title {
  tmdbId: number;
  mediaType: MediaType;
  name: string;
  year: number | null;
  posterPath: string | null;
  rating: number | null;
  inLists?: string[];
  imdbId?: string | null;
}

export interface ListSummary {
  id: number;
  slug: string;
  name: string;
  kind: string;
  systemKey: string | null;
  editable: boolean;
  sortMode: SortMode;
  showOnHome: boolean;
  seasonStart: string | null;
  seasonEnd: string | null;
  archived: boolean;
  inSeason: boolean;
  movieCount: number;
  seriesCount: number;
  missingImdbCount: number;
  hiddenCount: number;
  smartQuery: SmartQuery | null;
  smartLimit: number | null;
}

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

export interface StremioStatus {
  connected: boolean;
  email: string | null;
  lastSync: number | null;
  lastError: string | null;
  outOfSync: boolean;
}

export function timeAgo(ms: number | null) {
  if (!ms) return 'never';
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export type SortMode = 'manual' | 'added' | 'year' | 'rating' | 'name';

export interface Page {
  page: number;
  totalPages: number;
  results: Title[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login' && path !== '/api/setup') {
    window.dispatchEvent(new Event('unauthorized'));
  }
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const posterUrl = (path: string | null | undefined, size = 'w342') =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

export const titleKey = (t: { tmdbId: number; mediaType: MediaType }) => `${t.mediaType}:${t.tmdbId}`;

export const refOf = (t: Title) => ({ tmdbId: t.tmdbId, mediaType: t.mediaType });
