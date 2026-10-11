import type { MediaType } from './db.js';
import { findByImdb, summarize, tmdbGet, TTL, type TitleSummary } from './tmdb.js';

export interface ParsedLine {
  line: string;
  query: string;
  year: number | null;
}

/**
 * "Hocus Pocus (1993)", "Hocus Pocus [1993]", "Hocus Pocus - 1993", "1. Hocus Pocus".
 * A bare trailing number is left alone so "Wonder Woman 1984" and "Blade Runner 2049" survive.
 */
export function parseLine(line: string): ParsedLine | null {
  let s = line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
  if (!s) return null;
  let year: number | null = null;
  const m = s.match(/^(.*?)\s*(?:\((\d{4})\)|\[(\d{4})\]|\s[,–-]\s*(\d{4})|,\s*(\d{4}))\s*$/);
  if (m && m[1].trim()) {
    year = Number(m[2] ?? m[3] ?? m[4] ?? m[5]);
    s = m[1].trim();
  }
  return { line: line.trim(), query: s, year };
}

export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}

export function score(c: TitleSummary, p: ParsedLine): number {
  const a = normalize(c.name);
  const b = normalize(p.query);
  let s = a === b ? 1 : a.startsWith(b) || b.startsWith(a) ? 0.6 : a.includes(b) || b.includes(a) ? 0.4 : 0.1;
  if (p.year && c.year) {
    if (c.year === p.year) s += 0.5;
    else if (Math.abs(c.year - p.year) === 1) s += 0.25;
    else s -= 0.3;
  }
  return s;
}

export interface MatchResult {
  line: string;
  query: string;
  year: number | null;
  match: TitleSummary | null;
  confident: boolean;
  alternates: TitleSummary[];
}

export async function matchLine(p: ParsedLine, type: MediaType | 'any'): Promise<MatchResult> {
  const id = p.query.match(/^tt\d{5,10}$/)?.[0];
  if (id) return { ...(await resolveEntry({ imdbId: id, mediaType: type === 'any' ? undefined : type, label: p.line })), year: p.year };
  let candidates: TitleSummary[] = [];
  if (type === 'any') {
    const res = await tmdbGet('/search/multi', { query: p.query, include_adult: 'false' });
    candidates = res.results.map((r: any) => summarize(r)).filter(Boolean);
  } else {
    const endpoint = type === 'movie' ? '/search/movie' : '/search/tv';
    const yearParam = type === 'movie' ? 'primary_release_year' : 'first_air_date_year';
    const res = await tmdbGet(endpoint, { query: p.query, include_adult: 'false', [yearParam]: p.year ?? undefined });
    candidates = res.results.map((r: any) => summarize(r, type)).filter(Boolean);
    if (!candidates.length && p.year) {
      const retry = await tmdbGet(endpoint, { query: p.query, include_adult: 'false' });
      candidates = retry.results.map((r: any) => summarize(r, type)).filter(Boolean);
    }
  }

  // TMDB's order reflects popularity; keep it as the tiebreaker.
  const ranked = candidates
    .slice(0, 10)
    .map((c, i) => ({ c, s: score(c, p) - i * 0.01 }))
    .sort((a, b) => b.s - a.s);
  const best = ranked[0];
  const confident =
    !!best &&
    normalize(best.c.name) === normalize(p.query) &&
    (!p.year || best.c.year === p.year) &&
    // Two exact-name hits with no year to separate them (remakes) need a human.
    !(ranked[1] && !p.year && normalize(ranked[1].c.name) === normalize(p.query) && ranked[1].c.mediaType === best.c.mediaType);

  return {
    line: p.line,
    query: p.query,
    year: p.year,
    match: best?.c ?? null,
    confident,
    alternates: ranked.slice(1, 6).map((r) => r.c),
  };
}

export async function matchLines(text: string, type: MediaType | 'any'): Promise<MatchResult[]> {
  const parsed = text
    .split(/\r?\n/)
    .map(parseLine)
    .filter((p): p is ParsedLine => !!p)
    .slice(0, 300);
  return Promise.all(
    parsed.map((p) =>
      matchLine(p, type).catch(() => ({ ...p, match: null, confident: false, alternates: [] }) as MatchResult),
    ),
  );
}

// ---------- ID-based import (MDBList, Trakt, IMDb exports, any JSON/CSV with IDs) ----------

export interface ExternalEntry {
  imdbId?: string;
  tmdbId?: number;
  mediaType?: MediaType;
  label: string;
}

const IMDB_RE = /\btt\d{5,10}\b/g;

function typeOf(v: unknown): MediaType | undefined {
  const s = String(v ?? '').toLowerCase();
  if (s === 'movie' || s === 'film') return 'movie';
  if (s === 'show' || s === 'series' || s === 'tv' || s === 'tvshow' || s === 'episode') return 'series';
  return undefined;
}

/** Pull title IDs out of an object from any of the common list export shapes. */
function entryFrom(o: Record<string, any>, hintType?: MediaType): ExternalEntry | null {
  const ids = typeof o.ids === 'object' && o.ids ? o.ids : {};
  const imdbRaw = o.imdb_id ?? o.imdbid ?? o.imdbId ?? o.imdb ?? ids.imdb ?? o.Const ?? o.const;
  const imdbId = typeof imdbRaw === 'string' && /^tt\d{5,10}$/.test(imdbRaw.trim()) ? imdbRaw.trim() : undefined;
  const tmdbRaw = o.tmdb_id ?? o.tmdbid ?? o.tmdbId ?? ids.tmdb;
  const tmdbId = Number.isInteger(Number(tmdbRaw)) && Number(tmdbRaw) > 0 ? Number(tmdbRaw) : undefined;
  if (!imdbId && !tmdbId) return null;
  const mediaType = typeOf(o.mediatype ?? o.media_type ?? o.type ?? o['Title Type']) ?? hintType;
  const name = o.title ?? o.name ?? o.Title ?? '';
  const year = o.release_year ?? o.year ?? o.Year ?? '';
  return { imdbId, tmdbId, mediaType, label: [name, year && `(${year})`].filter(Boolean).join(' ') || imdbId || `TMDB ${tmdbId}` };
}

function walk(v: unknown, hintType: MediaType | undefined, out: ExternalEntry[], depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) walk(x, hintType, out, depth + 1);
    return;
  }
  const o = v as Record<string, any>;
  const e = entryFrom(o, hintType);
  if (e) {
    out.push(e);
    return;
  }
  // Trakt wraps items as { type: 'movie', movie: {...} }; MDBList combined lists use { movies: [], shows: [] }.
  for (const [k, child] of Object.entries(o)) {
    walk(child, typeOf(k.replace(/s$/, '')) ?? typeOf(o.type) ?? hintType, out, depth + 1);
  }
}

/** Parse JSON (any shape) or fall back to scanning CSV/plain text for IMDb IDs. */
export function extractEntries(text: string): ExternalEntry[] {
  const out: ExternalEntry[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      walk(JSON.parse(trimmed), undefined, out);
    } catch {
      // not JSON after all; scan as text
    }
  }
  if (!out.length) {
    for (const line of text.split(/\r?\n/)) {
      for (const id of line.match(IMDB_RE) ?? []) out.push({ imdbId: id, label: line.trim().slice(0, 120) || id });
    }
  }
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = e.imdbId ?? `${e.mediaType}:${e.tmdbId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function resolveEntry(e: ExternalEntry): Promise<MatchResult> {
  let match: TitleSummary | null = null;
  if (e.imdbId) match = await findByImdb(e.imdbId, e.mediaType).catch(() => null);
  if (!match && e.tmdbId && e.mediaType) {
    const d = await tmdbGet(`/${e.mediaType === 'movie' ? 'movie' : 'tv'}/${e.tmdbId}`, {}, TTL.details).catch(() => null);
    match = d ? summarize(d, e.mediaType) : null;
  }
  return { line: e.label, query: e.label, year: null, match, confident: !!match, alternates: [] };
}

/** mdblist.com/lists/<user>/<list> pages export their items as JSON at the same path plus /json. */
export function normalizeListUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https links work');
  if (/(^|\.)mdblist\.com$/.test(u.hostname)) {
    const m = u.pathname.match(/^\/lists\/([^/]+)\/([^/]+)/);
    if (m) u.pathname = `/lists/${m[1]}/${m[2]}/json`;
  }
  return u.toString();
}

export async function fetchListText(url: string): Promise<string> {
  const res = await fetch(normalizeListUrl(url), {
    headers: { accept: 'application/json, text/csv, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'stremio-personal-lists' },
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`That link returned ${res.status}${res.status === 404 ? ' (is the list public?)' : ''}`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new Error('That list is too large');
  return text;
}

export async function resolveEntries(entries: ExternalEntry[]): Promise<MatchResult[]> {
  return Promise.all(entries.slice(0, 1000).map(resolveEntry));
}
