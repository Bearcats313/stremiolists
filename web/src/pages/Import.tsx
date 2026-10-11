import { useState } from 'react';
import { api, posterUrl, titleKey, type Title } from '../api';
import { AddDialog } from '../components/AddDialog';
import { DetailDrawer } from '../components/DetailDrawer';
import { PosterCard } from '../components/Poster';

interface MatchRow {
  line: string;
  query: string;
  year: number | null;
  match: Title | null;
  confident: boolean;
  alternates: Title[];
}

interface Row extends MatchRow {
  chosen: Title | null;
  checked: boolean;
}

export function Import() {
  const [text, setText] = useState('');
  const [type, setType] = useState<'any' | 'movie' | 'series'>('any');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [drawer, setDrawer] = useState<Title | null>(null);

  async function match() {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ results: MatchRow[] }>('/api/import/match', { body: { text, type } });
      setRows(r.results.map((m) => ({ ...m, chosen: m.match, checked: !!m.match })));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const selected = (rows ?? []).filter((r) => r.checked && r.chosen).map((r) => r.chosen!);
  // The same title can be matched from two lines; add it once.
  const unique = [...new Map(selected.map((t) => [titleKey(t), t])).values()];
  const flagged = (rows ?? []).filter((r) => !r.confident).length;

  if (!rows) {
    return (
      <div className="page narrow">
        <h1>Paste import</h1>
        <p className="muted">One title per line. Add the year in parentheses to pin the right version, e.g. “Hocus Pocus (1993)”.</p>
        <textarea
          className="paste"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Hocus Pocus (1993)\nHalloweentown\nIt\'s the Great Pumpkin, Charlie Brown'}
          rows={14}
        />
        <div className="row-gap">
          <label className="field inline">
            <span>Match as</span>
            <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="any">Movies and TV</option>
              <option value="movie">Movies only</option>
              <option value="series">TV only</option>
            </select>
          </label>
          <button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={match}>
            {busy ? 'Matching…' : 'Match titles'}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="grid-head">
        <h1>Review matches</h1>
        <button type="button" className="btn ghost" onClick={() => setRows(null)}>
          Edit text
        </button>
      </div>
      <p className="muted">
        {rows.length} lines, {unique.length} checked.
        {flagged > 0 && ` ${flagged} need a look (highlighted); pick the right title or uncheck it.`}
      </p>

      <div className="grid">
        {rows.map((r, i) => (
          <div key={i} className={`import-cell${r.confident ? '' : ' flagged'}`}>
            <div className="import-line" title={r.line}>
              {r.line}
            </div>
            {r.chosen ? (
              <PosterCard
                title={r.chosen}
                selected={r.checked}
                onToggle={() => update(i, { checked: !r.checked })}
                onInfo={() => setDrawer(r.chosen)}
              />
            ) : (
              <div className="no-match">No match</div>
            )}
            {!r.confident && r.alternates.length > 0 && (
              <details className="alternates">
                <summary>Other matches</summary>
                {[r.match, ...r.alternates]
                  .filter((a): a is Title => !!a && a !== r.chosen)
                  .map((a) => (
                    <button
                      key={titleKey(a)}
                      type="button"
                      className="alt"
                      onClick={() => update(i, { chosen: a, checked: true, confident: true })}
                    >
                      {a.posterPath && <img src={posterUrl(a.posterPath, 'w92')!} alt="" />}
                      <span>
                        {a.name} ({a.year ?? '?'}) · {a.mediaType === 'movie' ? 'Movie' : 'TV'}
                      </span>
                    </button>
                  ))}
              </details>
            )}
          </div>
        ))}
      </div>

      <div className="tray">
        <div className="tray-count">{unique.length} checked</div>
        <div className="tray-thumbs" />
        <button type="button" className="btn primary" disabled={!unique.length} onClick={() => setAdding(true)}>
          Add to lists
        </button>
      </div>

      {adding && (
        <AddDialog
          items={unique}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            setRows(null);
            setText('');
          }}
        />
      )}
      {drawer && <DetailDrawer title={drawer} onClose={() => setDrawer(null)} selectable={false} />}
    </div>
  );
}
