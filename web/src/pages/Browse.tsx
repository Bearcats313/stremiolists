import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type MediaType, type Page, type Title } from '../api';
import { DetailDrawer } from '../components/DetailDrawer';
import { PosterGrid } from '../components/Poster';
import { useSelection } from '../state';

interface Filters {
  genres: number[];
  keywords: { id: number; name: string }[];
  yearFrom: string;
  yearTo: string;
  certs: string[];
  minRating: string;
  minVotes: string;
  services: string[];
}

const EMPTY: Filters = { genres: [], keywords: [], yearFrom: '', yearTo: '', certs: [], minRating: '', minVotes: '', services: [] };

interface FilterMeta {
  genres: { id: number; name: string }[];
  certifications: string[];
  services: string[];
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function countFilters(f: Filters) {
  return (
    f.genres.length +
    f.keywords.length +
    f.certs.length +
    f.services.length +
    [f.yearFrom, f.yearTo, f.minRating, f.minVotes].filter(Boolean).length
  );
}

function toggleIn<T>(arr: T[], v: T) {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

export function Browse() {
  const [type, setType] = useState<MediaType>(() => (localStorage.getItem('browseType') as MediaType) || 'movie');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const df = useDebounced(filters, 400);
  const [showFilters, setShowFilters] = useState(false);
  const [mode, setMode] = useState<'trending' | 'popular'>('trending');
  const [related, setRelated] = useState<Title | null>(null);
  const [meta, setMeta] = useState<FilterMeta | null>(null);

  const [results, setResults] = useState<Title[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState<Title | null>(null);
  const sel = useSelection();
  const reqId = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem('browseType', type);
    } catch {
      // ignore
    }
    setMeta(null);
    api<FilterMeta>(`/api/meta/filters?type=${type}`).then(setMeta).catch(() => {});
  }, [type]);

  const buildUrl = useCallback(
    (pg: number) => {
      if (related) return `/api/title/${related.mediaType}/${related.tmdbId}/related?page=${pg}`;
      const p = new URLSearchParams({ type, page: String(pg) });
      if (dq) p.set('q', dq);
      else {
        if (df.genres.length) p.set('genres', df.genres.join(','));
        if (df.keywords.length) p.set('keywords', df.keywords.map((k) => k.id).join(','));
        if (df.certs.length) p.set('certs', df.certs.join(','));
        if (df.services.length) p.set('services', df.services.join(','));
        if (/^\d{4}$/.test(df.yearFrom)) p.set('yearFrom', df.yearFrom);
        if (/^\d{4}$/.test(df.yearTo)) p.set('yearTo', df.yearTo);
        if (df.minRating) p.set('minRating', df.minRating);
        if (df.minVotes) p.set('minVotes', df.minVotes);
        p.set('mode', mode);
      }
      return `/api/browse?${p}`;
    },
    [type, dq, df, mode, related],
  );

  const load = useCallback(
    async (pg: number) => {
      const id = ++reqId.current;
      setLoading(true);
      setError('');
      try {
        const r = await api<Page>(buildUrl(pg));
        if (id !== reqId.current) return;
        setResults((prev) => {
          if (pg === 1) return r.results;
          const seen = new Set(prev.map((t) => `${t.mediaType}:${t.tmdbId}`));
          return [...prev, ...r.results.filter((t) => !seen.has(`${t.mediaType}:${t.tmdbId}`))];
        });
        setPage(pg);
        setTotalPages(r.totalPages);
      } catch (e: any) {
        if (id === reqId.current) setError(e.message);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [buildUrl],
  );

  useEffect(() => {
    setResults([]);
    setPage(0);
    window.scrollTo({ top: 0 });
    void load(1);
  }, [load]);

  // Refresh list badges after adding the selection to lists.
  useEffect(() => {
    const on = () => void load(1);
    window.addEventListener('lists-changed', on);
    return () => window.removeEventListener('lists-changed', on);
  }, [load]);

  const loadMore = () => {
    if (!loading && page > 0 && page < totalPages && !error) void load(page + 1);
  };

  const switchType = (t: MediaType) => {
    if (t === type) return;
    setType(t);
    setFilters(EMPTY);
    setRelated(null);
  };

  const nFilters = countFilters(filters);
  const heading = related
    ? `More like ${related.name}`
    : dq
      ? `Results for “${dq}”`
      : countFilters(df)
        ? 'Filtered'
        : mode === 'trending'
          ? 'Trending this week'
          : 'Popular';

  return (
    <div className="page">
      <div className="browse-bar">
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={type === 'movie'} onClick={() => switchType('movie')}>
            Movies
          </button>
          <button type="button" role="tab" aria-selected={type === 'series'} onClick={() => switchType('series')}>
            TV
          </button>
        </div>
        <input
          className="search"
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setRelated(null);
          }}
          placeholder={`Search ${type === 'movie' ? 'movies' : 'TV shows'}`}
          enterKeyHint="search"
        />
        <button
          type="button"
          className={`btn${showFilters ? ' active' : ''}`}
          onClick={() => setShowFilters((s) => !s)}
          aria-expanded={showFilters}
        >
          Filters{nFilters ? ` (${nFilters})` : ''}
        </button>
      </div>

      {showFilters && (
        <FilterPanel
          type={type}
          meta={meta}
          filters={filters}
          disabled={!!dq}
          onChange={(f) => {
            setFilters(f);
            setRelated(null);
          }}
        />
      )}

      <div className="grid-head">
        <h2>{heading}</h2>
        {!dq && !countFilters(df) && !related && (
          <div className="segmented small">
            <button type="button" aria-selected={mode === 'trending'} onClick={() => setMode('trending')}>
              Trending
            </button>
            <button type="button" aria-selected={mode === 'popular'} onClick={() => setMode('popular')}>
              Popular
            </button>
          </div>
        )}
        {related && (
          <button type="button" className="btn ghost" onClick={() => setRelated(null)}>
            Back
          </button>
        )}
      </div>
      <div className="grid-tools">
        <button type="button" className="btn ghost" onClick={() => sel.addMany(results)} disabled={!results.length}>
          Select all on this page
        </button>
        <button type="button" className="btn ghost" onClick={sel.clear} disabled={!sel.items.length}>
          Clear selection
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {!loading && !error && page > 0 && !results.length && <p className="muted">Nothing found.</p>}
      <PosterGrid
        titles={results}
        isSelected={sel.has}
        onToggle={sel.toggle}
        onInfo={setDrawer}
        onLoadMore={loadMore}
        loading={loading}
      />

      {drawer && (
        <DetailDrawer
          title={drawer}
          onClose={() => setDrawer(null)}
          onMoreLikeThis={(t) => {
            setDrawer(null);
            setQ('');
            setRelated(t);
          }}
        />
      )}
    </div>
  );
}

function FilterPanel({
  type,
  meta,
  filters: f,
  disabled,
  onChange,
}: {
  type: MediaType;
  meta: FilterMeta | null;
  filters: Filters;
  disabled: boolean;
  onChange: (f: Filters) => void;
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...f, ...patch });
  const [kw, setKw] = useState('');
  const dkw = useDebounced(kw.trim(), 250);
  const [kwResults, setKwResults] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    if (!dkw) return setKwResults([]);
    api<{ results: { id: number; name: string }[] }>(`/api/meta/keywords?q=${encodeURIComponent(dkw)}`)
      .then((r) => setKwResults(r.results))
      .catch(() => setKwResults([]));
  }, [dkw]);

  return (
    <div className={`filters${disabled ? ' disabled' : ''}`}>
      {disabled && <p className="muted small">Filters don't apply while searching by title. Clear the search to use them.</p>}

      <fieldset>
        <legend>Genre</legend>
        <div className="chips">
          {meta?.genres.map((g) => (
            <button
              key={g.id}
              type="button"
              className="chip"
              aria-pressed={f.genres.includes(g.id)}
              onClick={() => set({ genres: toggleIn(f.genres, g.id) })}
            >
              {g.name}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Keyword</legend>
        <div className="chips">
          {f.keywords.map((k) => (
            <button
              key={k.id}
              type="button"
              className="chip"
              aria-pressed
              onClick={() => set({ keywords: f.keywords.filter((x) => x.id !== k.id) })}
            >
              {k.name} ×
            </button>
          ))}
        </div>
        <div className="autocomplete">
          <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="halloween, christmas, heist…" />
          {kwResults.length > 0 && (
            <ul>
              {kwResults.map((k) => (
                <li key={k.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!f.keywords.some((x) => x.id === k.id)) set({ keywords: [...f.keywords, k] });
                      setKw('');
                      setKwResults([]);
                    }}
                  >
                    {k.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend>Rating ({type === 'movie' ? 'MPA' : 'TV'})</legend>
        <div className="chips">
          {meta?.certifications.map((c) => (
            <button key={c} type="button" className="chip" aria-pressed={f.certs.includes(c)} onClick={() => set({ certs: toggleIn(f.certs, c) })}>
              {c}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Streaming on (US)</legend>
        <div className="chips">
          {meta?.services.map((s) => (
            <button
              key={s}
              type="button"
              className="chip"
              aria-pressed={f.services.includes(s)}
              onClick={() => set({ services: toggleIn(f.services, s) })}
            >
              {s}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="filter-row">
        <label className="field">
          <span>Year from</span>
          <input inputMode="numeric" value={f.yearFrom} onChange={(e) => set({ yearFrom: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
        </label>
        <label className="field">
          <span>Year to</span>
          <input inputMode="numeric" value={f.yearTo} onChange={(e) => set({ yearTo: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
        </label>
        <label className="field">
          <span>Min TMDB rating</span>
          <select value={f.minRating} onChange={(e) => set({ minRating: e.target.value })}>
            <option value="">Any</option>
            {[5, 6, 6.5, 7, 7.5, 8].map((n) => (
              <option key={n} value={n}>
                {n.toFixed(1)}+
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Min votes</span>
          <select value={f.minVotes} onChange={(e) => set({ minVotes: e.target.value })}>
            <option value="">Any</option>
            {[50, 200, 1000, 5000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}+
              </option>
            ))}
          </select>
        </label>
      </div>
      {countFilters(f) > 0 && (
        <button type="button" className="btn ghost" onClick={() => onChange(EMPTY)}>
          Reset filters
        </button>
      )}
    </div>
  );
}
