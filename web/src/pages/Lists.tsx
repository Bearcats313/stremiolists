import { useEffect, useRef, useState } from 'react';
import { api, type ListSummary } from '../api';
import { go } from '../router';
import { useToast } from '../state';

export function seasonLabel(l: ListSummary) {
  if (!l.seasonStart || !l.seasonEnd) return null;
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${fmt(l.seasonStart)} – ${fmt(l.seasonEnd)}`;
}

export function Lists() {
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [seasonal, setSeasonal] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const load = () =>
    api<{ lists: ListSummary[] }>('/api/lists')
      .then((r) => setLists(r.lists))
      .catch((e) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    try {
      const l = await api<ListSummary>('/api/lists', {
        body: { name, seasonStart: seasonal ? start : null, seasonEnd: seasonal ? end : null },
      });
      setName('');
      setSeasonal(false);
      go(`lists/${l.id}`);
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function toggleHome(l: ListSummary) {
    try {
      await api(`/api/lists/${l.id}`, { method: 'PATCH', body: { showOnHome: !l.showOnHome } });
      await load();
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function importFile(file: File) {
    try {
      const data = JSON.parse(await file.text());
      const l = await api<ListSummary>('/api/lists/import', { body: data });
      toast(`Imported ${l.name}`);
      await load();
    } catch (e: any) {
      toast(e instanceof SyntaxError ? 'That file is not valid JSON' : e.message);
    }
  }

  if (error) return <p className="error page">{error}</p>;
  if (!lists) return <div className="spinner page" />;

  // Trending and Suggestions arrive in later phases; hide them until they have content.
  const visible = lists.filter((l) => l.editable || l.movieCount + l.seriesCount > 0);
  const active = visible.filter((l) => !l.archived);
  const archived = visible.filter((l) => l.archived);

  const card = (l: ListSummary) => (
    <div key={l.id} className="list-card">
      <a href={`#/lists/${l.id}`} className="list-card-main">
        <div className="list-name">
          {l.name}
          {l.kind === 'system' && <span className="tag">system</span>}
        </div>
        <div className="muted small">
          {l.movieCount} {l.movieCount === 1 ? 'movie' : 'movies'} · {l.seriesCount} series
          {l.missingImdbCount > 0 && <span className="warn"> · {l.missingImdbCount} without IMDb ID</span>}
        </div>
        {seasonLabel(l) && (
          <div className="small">
            {seasonLabel(l)}
            {!l.archived && !l.inSeason && <span className="muted"> · not in season yet</span>}
          </div>
        )}
      </a>
      {l.systemKey !== 'watched' && (
        <label className="switch" title="Show on the Stremio home screen">
          <input type="checkbox" checked={l.showOnHome} onChange={() => toggleHome(l)} />
          <span>Home</span>
        </label>
      )}
    </div>
  );

  return (
    <div className="page narrow">
      <div className="grid-head">
        <h1>Lists</h1>
        <button type="button" className="btn ghost" onClick={() => fileInput.current?.click()}>
          Import JSON
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = '';
          }}
        />
      </div>

      <div className="new-list">
        <div className="inline-form">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New list name" />
          <button type="button" className="btn primary" disabled={!name.trim() || (seasonal && (!start || !end))} onClick={create}>
            Create
          </button>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={seasonal} onChange={(e) => setSeasonal(e.target.checked)} />
          <span>Seasonal</span>
        </label>
        {seasonal && (
          <div className="filter-row">
            <label className="field">
              <span>Shows from</span>
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="field">
              <span>Until</span>
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>
        )}
      </div>

      <div className="list-cards">{active.map(card)}</div>

      {archived.length > 0 && (
        <>
          <h2>Archived</h2>
          <p className="muted small">Seasonal lists whose end date has passed. Open one and set new dates to bring it back.</p>
          <div className="list-cards">{archived.map(card)}</div>
        </>
      )}
    </div>
  );
}
