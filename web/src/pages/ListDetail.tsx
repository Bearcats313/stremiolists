import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useCallback, useEffect, useState } from 'react';
import { api, refOf, titleKey, type ListSummary, type SortMode, type Title } from '../api';
import { DetailDrawer } from '../components/DetailDrawer';
import { PosterCard } from '../components/Poster';
import { go } from '../router';
import { useToast } from '../state';

const SORTS: { value: SortMode; label: string }[] = [
  { value: 'manual', label: 'Manual (drag to reorder)' },
  { value: 'added', label: 'Date added' },
  { value: 'year', label: 'Year, newest first' },
  { value: 'rating', label: 'TMDB rating' },
  { value: 'name', label: 'Title A–Z' },
];

function SortableCard(props: {
  title: Title;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  onInfo: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: titleKey(props.title),
    disabled: props.disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 5 : undefined }}
      className={isDragging ? 'dragging' : undefined}
      {...attributes}
      {...listeners}
    >
      <PosterCard
        title={props.title}
        selected={props.selected}
        onToggle={props.onToggle}
        onInfo={props.onInfo}
        extraBadge={!props.title.imdbId ? <span className="badge warn-badge">No IMDb ID</span> : undefined}
      />
    </div>
  );
}

export function ListDetail({ id }: { id: number }) {
  const [list, setList] = useState<ListSummary | null>(null);
  const [items, setItems] = useState<Title[]>([]);
  const [others, setOthers] = useState<ListSummary[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'movie' | 'series'>('all');
  const [drawer, setDrawer] = useState<Title | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [target, setTarget] = useState('');
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [d, all] = await Promise.all([
        api<{ list: ListSummary; items: Title[] }>(`/api/lists/${id}`),
        api<{ lists: ListSummary[] }>('/api/lists'),
      ]);
      setList(d.list);
      setItems(d.items);
      setOthers(all.lists.filter((l) => l.editable && l.id !== id));
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    setSelected(new Set());
    void load();
  }, [load]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (error) return <p className="error page">{error}</p>;
  if (!list) return <div className="spinner page" />;

  const shown = items.filter((t) => filter === 'all' || t.mediaType === filter);
  const selectedItems = items.filter((t) => selected.has(titleKey(t)));

  const toggle = (t: Title) =>
    setSelected((s) => {
      const n = new Set(s);
      const k = titleKey(t);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  async function patch(body: Record<string, unknown>) {
    try {
      setList(await api<ListSummary>(`/api/lists/${id}`, { method: 'PATCH', body }));
      if ('sortMode' in body) await load();
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = shown.findIndex((t) => titleKey(t) === e.active.id);
    const to = shown.findIndex((t) => titleKey(t) === e.over!.id);
    const reordered = arrayMove(shown, from, to);
    // Catalogs are per type, so reordering a filtered view only needs that view's order.
    const rest = items.filter((t) => !shown.includes(t));
    setItems([...reordered, ...rest]);
    setList((l) => l && { ...l, sortMode: 'manual' });
    try {
      await api(`/api/lists/${id}/reorder`, { body: { items: reordered.map(refOf) } });
    } catch (err: any) {
      toast(err.message);
      void load();
    }
  }

  async function removeSelected() {
    if (!confirm(`Remove ${selectedItems.length} from ${list!.name}?`)) return;
    try {
      const r = await api<{ removed: number }>(`/api/lists/${id}/remove`, { body: { items: selectedItems.map(refOf) } });
      toast(`Removed ${r.removed}`);
      setSelected(new Set());
      await load();
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function transfer(mode: 'move' | 'copy') {
    const dest = others.find((l) => String(l.id) === target);
    if (!dest) return;
    try {
      const r = await api<{ added: number; skipped: number }>(`/api/lists/${id}/transfer`, {
        body: { items: selectedItems.map(refOf), targetListId: dest.id, mode },
      });
      toast(`${mode === 'move' ? 'Moved' : 'Copied'} ${r.added} to ${dest.name}${r.skipped ? `; ${r.skipped} already there` : ''}`);
      setSelected(new Set());
      await load();
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function duplicate() {
    try {
      const l = await api<ListSummary>(`/api/lists/${id}/duplicate`, { method: 'POST', body: {} });
      toast(`Created ${l.name}`);
      go(`lists/${l.id}`);
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function remove() {
    if (!confirm(`Delete “${list!.name}” and its ${items.length} titles? This can't be undone.`)) return;
    try {
      await api(`/api/lists/${id}`, { method: 'DELETE' });
      go('lists');
    } catch (e: any) {
      toast(e.message);
    }
  }

  return (
    <div className="page">
      <div className="grid-head">
        <h1>{list.name}</h1>
        <button type="button" className={`btn${showSettings ? ' active' : ''}`} onClick={() => setShowSettings((s) => !s)}>
          List settings
        </button>
      </div>
      <p className="muted small">
        {list.movieCount} {list.movieCount === 1 ? 'movie' : 'movies'} · {list.seriesCount} series
        {list.archived && ' · archived'}
        {!list.archived && !list.inSeason && ' · hidden in Stremio until its start date'}
        {list.missingImdbCount > 0 && ` · ${list.missingImdbCount} without an IMDb ID won't show in Stremio`}
      </p>

      {showSettings && (
        <ListSettings list={list} onPatch={patch} onDuplicate={duplicate} onDelete={remove} />
      )}

      <div className="grid-tools">
        <div className="segmented small">
          {(['all', 'movie', 'series'] as const).map((f) => (
            <button key={f} type="button" aria-selected={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'movie' ? 'Movies' : 'TV'}
            </button>
          ))}
        </div>
        <label className="field inline">
          <span>Sort</span>
          <select value={list.sortMode} onChange={(e) => patch({ sortMode: e.target.value })}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {list.editable && (
          <button
            type="button"
            className="btn ghost"
            onClick={() => setSelected(new Set(shown.map(titleKey)))}
            disabled={!shown.length}
          >
            Select all
          </button>
        )}
      </div>
      {list.editable && shown.length > 1 && (
        <p className="muted small">Tap to select. Drag to reorder (press and hold on touch screens).</p>
      )}

      {!items.length && (
        <p className="muted">
          Empty. Add titles from <a href="#/browse">Browse</a> or <a href="#/import">Paste import</a>.
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shown.map(titleKey)} strategy={rectSortingStrategy}>
          <div className="grid">
            {shown.map((t) => (
              <SortableCard
                key={titleKey(t)}
                title={t}
                selected={selected.has(titleKey(t))}
                disabled={!list.editable}
                onToggle={() => list.editable && toggle(t)}
                onInfo={() => setDrawer(t)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {selectedItems.length > 0 && (
        <div className="tray">
          <div className="tray-count">{selectedItems.length} selected</div>
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target list">
            <option value="">Another list…</option>
            {others.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn" disabled={!target} onClick={() => transfer('copy')}>
            Copy
          </button>
          <button type="button" className="btn" disabled={!target} onClick={() => transfer('move')}>
            Move
          </button>
          <button type="button" className="btn danger" onClick={removeSelected}>
            Remove
          </button>
          <button type="button" className="btn ghost" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {drawer && (
        <DetailDrawer
          title={drawer}
          selectable={false}
          onClose={() => {
            setDrawer(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ListSettings({
  list,
  onPatch,
  onDuplicate,
  onDelete,
}: {
  list: ListSummary;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(list.name);
  const [start, setStart] = useState(list.seasonStart ?? '');
  const [end, setEnd] = useState(list.seasonEnd ?? '');
  const isSystem = list.kind === 'system';

  useEffect(() => {
    setName(list.name);
    setStart(list.seasonStart ?? '');
    setEnd(list.seasonEnd ?? '');
  }, [list]);

  const datesChanged = start !== (list.seasonStart ?? '') || end !== (list.seasonEnd ?? '');

  return (
    <div className="settings-panel">
      {!isSystem && (
        <div className="inline-form">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="List name" />
          <button type="button" className="btn" disabled={!name.trim() || name === list.name} onClick={() => onPatch({ name })}>
            Rename
          </button>
        </div>
      )}

      {list.systemKey !== 'watched' && (
        <label className="check-row">
          <input type="checkbox" checked={list.showOnHome} onChange={() => onPatch({ showOnHome: !list.showOnHome })} />
          <span>Show on the Stremio home screen (otherwise only in Discover)</span>
        </label>
      )}

      {!isSystem && (
        <>
          <h3>Seasonal dates</h3>
          <p className="muted small">Outside these dates the list is hidden in Stremio. After the end date it moves to Archived.</p>
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
          <div className="row-gap">
            <button
              type="button"
              className="btn"
              disabled={!datesChanged || !start !== !end}
              onClick={() => onPatch({ seasonStart: start || null, seasonEnd: end || null })}
            >
              Save dates
            </button>
            {(list.seasonStart || list.seasonEnd) && (
              <button type="button" className="btn ghost" onClick={() => onPatch({ seasonStart: null, seasonEnd: null })}>
                Not seasonal
              </button>
            )}
          </div>
        </>
      )}

      <div className="row-gap">
        <button type="button" className="btn" onClick={onDuplicate}>
          Duplicate
        </button>
        <a className="btn" href={`/api/lists/${list.id}/export`} download>
          Export JSON
        </a>
        {!isSystem && (
          <button type="button" className="btn danger" onClick={onDelete}>
            Delete list
          </button>
        )}
      </div>
    </div>
  );
}
