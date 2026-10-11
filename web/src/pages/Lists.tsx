import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useRef, useState } from 'react';
import { api, type ListSummary } from '../api';
import { SyncStatus } from '../components/SyncStatus';
import { go } from '../router';
import { useToast } from '../state';

export function seasonLabel(l: ListSummary) {
  if (!l.seasonStart || !l.seasonEnd) return null;
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${fmt(l.seasonStart)} – ${fmt(l.seasonEnd)}`;
}

function kindTag(l: ListSummary) {
  if (l.kind === 'smart') return 'smart';
  if (l.kind === 'system') return 'system';
  return null;
}

function ListCard({
  list: l,
  draggable,
  onToggleHome,
}: {
  list: ListSummary;
  draggable: boolean;
  onToggleHome: (l: ListSummary) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: l.id,
    disabled: !draggable,
  });
  const tag = kindTag(l);
  return (
    <div
      ref={setNodeRef}
      className={`list-card${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 5 : undefined }}
    >
      {draggable && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="drag-handle"
          aria-label={`Move ${l.name}`}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
      )}
      <a href={`#/lists/${l.id}`} className="list-card-main">
        <div className="list-name">
          {l.name}
          {tag && <span className="tag">{tag}</span>}
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
          <input type="checkbox" checked={l.showOnHome} onChange={() => onToggleHome(l)} />
          <span>Home</span>
        </label>
      )}
    </div>
  );
}

export function Lists() {
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [grouping, setGrouping] = useState<'list' | 'type'>('list');
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [seasonal, setSeasonal] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [changes, setChanges] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = () =>
    api<{ lists: ListSummary[] }>('/api/lists')
      .then((r) => setLists(r.lists))
      .catch((e) => setError(e.message));

  useEffect(() => {
    void load();
    api<{ rowGrouping: 'list' | 'type' }>('/api/settings')
      .then((s) => setGrouping(s.rowGrouping))
      .catch(() => {});
  }, []);

  const changed = () => setChanges((n) => n + 1);

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
      changed();
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function setRowGrouping(g: 'list' | 'type') {
    setGrouping(g);
    try {
      await api('/api/settings/rows', { body: { rowGrouping: g } });
      changed();
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function onDragEnd(e: DragEndEvent) {
    if (!lists || !e.over || e.active.id === e.over.id) return;
    const from = lists.findIndex((l) => l.id === e.active.id);
    const to = lists.findIndex((l) => l.id === e.over!.id);
    const next = arrayMove(lists, from, to);
    setLists(next);
    try {
      await api('/api/lists/order', { body: { ids: next.map((l) => l.id) } });
      changed();
    } catch (err: any) {
      toast(err.message);
      void load();
    }
  }

  async function importFile(file: File) {
    try {
      const data = JSON.parse(await file.text());
      const l = await api<ListSummary>('/api/lists/import', { body: data });
      toast(`Imported ${l.name}`);
      await load();
      changed();
    } catch (e: any) {
      toast(e instanceof SyntaxError ? 'That file is not valid JSON' : e.message);
    }
  }

  if (error) return <p className="error page">{error}</p>;
  if (!lists) return <div className="spinner page" />;

  // Suggestions arrive in phase 3; hide it until it has content.
  const visible = lists.filter((l) => l.systemKey !== 'suggestions' || l.movieCount + l.seriesCount > 0);
  const active = visible.filter((l) => !l.archived);
  const archived = visible.filter((l) => l.archived);

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

      <SyncStatus refreshKey={changes} />

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
        <p className="muted small">
          For a list that fills itself from filters, set up the filters on <a href="#/browse">Browse</a> and choose Save as smart list.
        </p>
      </div>

      <div className="rows-head">
        <p className="muted small">Drag ⋮⋮ to set the order of rows in Stremio.</p>
        <label className="field inline">
          <span>Rows</span>
          <select value={grouping} onChange={(e) => setRowGrouping(e.target.value as 'list' | 'type')}>
            <option value="list">Each list's movies, then its series</option>
            <option value="type">All movie rows, then all series rows</option>
          </select>
        </label>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={active.map((l) => l.id)} strategy={verticalListSortingStrategy}>
          <div className="list-cards">
            {active.map((l) => (
              <ListCard key={l.id} list={l} draggable onToggleHome={toggleHome} />
            ))}
          </div>
        </SortableContext>

        {archived.length > 0 && (
          <>
            <h2>Archived</h2>
            <p className="muted small">Seasonal lists whose end date has passed. Open one and set new dates to bring it back.</p>
            <SortableContext items={archived.map((l) => l.id)} strategy={verticalListSortingStrategy}>
              <div className="list-cards">
                {archived.map((l) => (
                  <ListCard key={l.id} list={l} draggable={false} onToggleHome={toggleHome} />
                ))}
              </div>
            </SortableContext>
          </>
        )}
      </DndContext>
    </div>
  );
}
