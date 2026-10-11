import { useEffect, useState } from 'react';
import { api, refOf, type ListSummary, type Title } from '../api';
import { useToast } from '../state';

interface Props {
  items: Title[];
  onClose: () => void;
  onAdded: () => void;
}

interface AddResult {
  reports: { listId: number; name: string; added: number; skipped: number }[];
  failed: number;
  missingImdb: number;
}

export function describeAdd(r: AddResult) {
  const parts = r.reports.map(
    (x) => `Added ${x.added} to ${x.name}${x.skipped ? `; ${x.skipped} ${x.skipped === 1 ? 'was' : 'were'} already there` : ''}`,
  );
  if (r.failed) parts.push(`${r.failed} couldn't be loaded from TMDB`);
  if (r.missingImdb) parts.push(`${r.missingImdb} have no IMDb ID and won't show in Stremio`);
  return parts.join('. ');
}

export function AddDialog({ items, onClose, onAdded }: Props) {
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  useEffect(() => {
    api<{ lists: ListSummary[] }>('/api/lists')
      .then((r) => setLists(r.lists.filter((l) => l.editable)))
      .catch((e) => setError(e.message));
  }, []);

  const toggle = (id: number) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const movies = items.filter((i) => i.mediaType === 'movie').length;
  const series = items.length - movies;
  const canSubmit = !busy && (checked.size > 0 || newName.trim());

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const r = await api<AddResult>('/api/lists/add', {
        body: { items: items.map(refOf), listIds: [...checked], newListName: newName.trim() || undefined },
      });
      toast(describeAdd(r));
      onAdded();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Add to lists" onClick={(e) => e.stopPropagation()}>
        <h2>Add {items.length} {items.length === 1 ? 'title' : 'titles'}</h2>
        <p className="muted">
          {movies} {movies === 1 ? 'movie' : 'movies'}, {series} {series === 1 ? 'series' : 'series'}. Each goes to the matching row
          of the list.
        </p>
        <div className="picker">
          {lists === null && !error && <div className="spinner" />}
          {lists?.map((l) => (
            <label key={l.id} className="check-row">
              <input type="checkbox" checked={checked.has(l.id)} onChange={() => toggle(l.id)} />
              <span>{l.name}</span>
              <span className="muted small">
                {l.movieCount + l.seriesCount}
                {l.archived ? ' · archived' : ''}
              </span>
            </label>
          ))}
        </div>
        <label className="field">
          <span>New list</span>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Christmas"
            onKeyDown={(e) => e.key === 'Enter' && canSubmit && submit()}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
