import type { MediaType } from './db.js';
import { summarize, tmdbGet, type TitleSummary } from './tmdb.js';

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
