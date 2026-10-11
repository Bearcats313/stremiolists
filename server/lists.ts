import { today } from './config.js';
import { db, type MediaType } from './db.js';
import type { TitleRef } from './titles.js';

export type SortMode = 'manual' | 'added' | 'year' | 'rating' | 'name';
export const SORT_MODES: SortMode[] = ['manual', 'added', 'year', 'rating', 'name'];

export interface ListRow {
  id: number;
  slug: string;
  name: string;
  kind: 'manual' | 'smart' | 'system';
  system_key: string | null;
  sort_mode: SortMode;
  show_on_home: number;
  season_start: string | null;
  season_end: string | null;
  archived: number;
  smart_query: string | null;
  smart_limit: number | null;
  created_at: number;
}

export class ListError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** System lists filled by the app (trending, suggestions) are not edited by hand. */
export function isEditable(l: ListRow) {
  return l.kind === 'manual' || l.system_key === 'library' || l.system_key === 'watched';
}

export function getList(id: number): ListRow {
  const l = db().prepare('SELECT * FROM lists WHERE id = ?').get(id) as ListRow | undefined;
  if (!l) throw new ListError('List not found', 404);
  return l;
}

export function getListBySlug(slug: string): ListRow | undefined {
  return db().prepare('SELECT * FROM lists WHERE slug = ?').get(slug) as ListRow | undefined;
}

function editableList(id: number) {
  const l = getList(id);
  if (!isEditable(l)) throw new ListError(`${l.name} is filled automatically and can't be edited`);
  return l;
}

export function slugify(name: string): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'list';
  let slug = base;
  for (let i = 2; getListBySlug(slug); i++) slug = `${base}-${i}`;
  return slug;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateSeason(start: string | null, end: string | null) {
  if (!start && !end) return;
  if (!start || !end) throw new ListError('Seasonal lists need both a start and end date');
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new ListError('Dates must be YYYY-MM-DD');
  if (end < start) throw new ListError('End date is before start date');
}

/** Seasonal lists are archived once the end date passes; new dates bring them back. */
export function refreshArchived(day = today()) {
  db()
    .prepare(
      `UPDATE lists SET archived = CASE WHEN season_end IS NOT NULL AND season_end < ? THEN 1 ELSE 0 END`,
    )
    .run(day);
}

/** Whether a list should currently appear in Stremio. */
export function isInSeason(l: ListRow, day = today()) {
  if (l.archived) return false;
  if (!l.season_start || !l.season_end) return true;
  return l.season_start <= day && day <= l.season_end;
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
}

export function toSummary(l: ListRow): ListSummary {
  const counts = db()
    .prepare(
      `SELECT
         SUM(li.media_type = 'movie') AS movies,
         SUM(li.media_type = 'series') AS series,
         SUM(t.imdb_id IS NULL) AS missing
       FROM list_items li LEFT JOIN titles t ON t.tmdb_id = li.tmdb_id AND t.media_type = li.media_type
       WHERE li.list_id = ? AND li.hidden = 0`,
    )
    .get(l.id) as { movies: number | null; series: number | null; missing: number | null };
  return {
    id: l.id,
    slug: l.slug,
    name: l.name,
    kind: l.kind,
    systemKey: l.system_key,
    editable: isEditable(l),
    sortMode: l.sort_mode,
    showOnHome: !!l.show_on_home,
    seasonStart: l.season_start,
    seasonEnd: l.season_end,
    archived: !!l.archived,
    inSeason: isInSeason(l),
    movieCount: counts.movies ?? 0,
    seriesCount: counts.series ?? 0,
    missingImdbCount: counts.missing ?? 0,
  };
}

export function allLists(): ListRow[] {
  return db()
    .prepare(
      `SELECT * FROM lists ORDER BY
         CASE system_key WHEN 'library' THEN 0 WHEN 'trending' THEN 1 WHEN 'suggestions' THEN 2 WHEN 'watched' THEN 9 ELSE 5 END,
         name COLLATE NOCASE`,
    )
    .all() as ListRow[];
}

export interface ListInput {
  name?: string;
  sortMode?: SortMode;
  showOnHome?: boolean;
  seasonStart?: string | null;
  seasonEnd?: string | null;
}

export function createList(input: ListInput & { name: string }): ListRow {
  const name = input.name.trim();
  if (!name) throw new ListError('List name is required');
  const start = input.seasonStart || null;
  const end = input.seasonEnd || null;
  validateSeason(start, end);
  const sort = input.sortMode && SORT_MODES.includes(input.sortMode) ? input.sortMode : 'manual';
  const info = db()
    .prepare(
      `INSERT INTO lists (slug, name, kind, sort_mode, show_on_home, season_start, season_end, archived, created_at)
       VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?)`,
    )
    .run(slugify(name), name, sort, input.showOnHome === false ? 0 : 1, start, end, end && end < today() ? 1 : 0, Date.now());
  return getList(Number(info.lastInsertRowid));
}

export function updateList(id: number, input: ListInput): ListRow {
  const l = getList(id);
  const name = input.name !== undefined ? String(input.name).trim() : l.name;
  if (!name) throw new ListError('List name is required');
  if (l.kind === 'system' && name !== l.name) throw new ListError('System lists cannot be renamed');
  const start = input.seasonStart !== undefined ? input.seasonStart || null : l.season_start;
  const end = input.seasonEnd !== undefined ? input.seasonEnd || null : l.season_end;
  validateSeason(start, end);
  const sort = input.sortMode ?? l.sort_mode;
  if (!SORT_MODES.includes(sort)) throw new ListError('Unknown sort mode');
  const home = input.showOnHome !== undefined ? (input.showOnHome ? 1 : 0) : l.show_on_home;
  db()
    .prepare(
      `UPDATE lists SET name = ?, sort_mode = ?, show_on_home = ?, season_start = ?, season_end = ?, archived = ? WHERE id = ?`,
    )
    .run(name, sort, home, start, end, end && end < today() ? 1 : 0, id);
  return getList(id);
}

export function deleteList(id: number) {
  const l = getList(id);
  if (l.kind === 'system') throw new ListError('System lists cannot be deleted');
  db().prepare('DELETE FROM lists WHERE id = ?').run(id);
}

function uniqueName(base: string) {
  const exists = db().prepare('SELECT 1 FROM lists WHERE name = ? COLLATE NOCASE');
  let name = base;
  for (let i = 2; exists.get(name); i++) name = `${base} ${i}`;
  return name;
}

export function duplicateList(id: number): ListRow {
  const src = getList(id);
  const copy = createList({
    name: uniqueName(`${src.name} copy`),
    sortMode: src.sort_mode,
    showOnHome: !!src.show_on_home,
    seasonStart: src.season_start,
    seasonEnd: src.season_end,
  });
  db()
    .prepare(
      `INSERT INTO list_items (list_id, tmdb_id, media_type, position, added_at, hidden)
       SELECT ?, tmdb_id, media_type, position, added_at, 0 FROM list_items WHERE list_id = ? AND hidden = 0`,
    )
    .run(copy.id, id);
  return copy;
}

export function findOrCreateByName(name: string): ListRow {
  const existing = db().prepare('SELECT * FROM lists WHERE name = ? COLLATE NOCASE').get(name.trim()) as
    | ListRow
    | undefined;
  return existing ?? createList({ name });
}

// ---------- Items ----------

export interface AddReport {
  listId: number;
  name: string;
  added: number;
  skipped: number;
}

export function addItems(listId: number, refs: TitleRef[]): AddReport {
  const l = editableList(listId);
  const d = db();
  const maxPos = (d.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM list_items WHERE list_id = ?').get(listId) as {
    p: number;
  }).p;
  const insert = d.prepare(
    `INSERT OR IGNORE INTO list_items (list_id, tmdb_id, media_type, position, added_at) VALUES (?, ?, ?, ?, ?)`,
  );
  let added = 0;
  const now = Date.now();
  d.transaction(() => {
    for (const r of refs) {
      const res = insert.run(listId, r.tmdbId, r.mediaType, maxPos + 1 + added, now);
      added += res.changes;
    }
  })();
  return { listId, name: l.name, added, skipped: refs.length - added };
}

export function removeItems(listId: number, refs: TitleRef[]): number {
  editableList(listId);
  const del = db().prepare('DELETE FROM list_items WHERE list_id = ? AND tmdb_id = ? AND media_type = ?');
  let n = 0;
  db().transaction(() => {
    for (const r of refs) n += del.run(listId, r.tmdbId, r.mediaType).changes;
  })();
  return n;
}

/** Apply a new manual order. Titles not in `refs` keep their relative order after the given ones. */
export function reorderItems(listId: number, refs: TitleRef[]) {
  editableList(listId);
  const d = db();
  const current = d
    .prepare('SELECT tmdb_id, media_type FROM list_items WHERE list_id = ? ORDER BY position')
    .all(listId) as { tmdb_id: number; media_type: MediaType }[];
  const key = (id: number, t: string) => `${t}:${id}`;
  const given = new Set(refs.map((r) => key(r.tmdbId, r.mediaType)));
  const ordered = [
    ...refs.map((r) => ({ tmdb_id: r.tmdbId, media_type: r.mediaType })),
    ...current.filter((c) => !given.has(key(c.tmdb_id, c.media_type))),
  ];
  const upd = d.prepare('UPDATE list_items SET position = ? WHERE list_id = ? AND tmdb_id = ? AND media_type = ?');
  d.transaction(() => ordered.forEach((o, i) => upd.run(i, listId, o.tmdb_id, o.media_type)))();
  // Manual reordering implies the user wants manual sort.
  d.prepare(`UPDATE lists SET sort_mode = 'manual' WHERE id = ?`).run(listId);
}

export function transferItems(fromId: number, toId: number, refs: TitleRef[], mode: 'move' | 'copy') {
  if (fromId === toId) throw new ListError('Pick a different list');
  if (mode === 'move') editableList(fromId);
  const report = addItems(toId, refs);
  if (mode === 'move') removeItems(fromId, refs);
  return report;
}

const ORDER_BY: Record<SortMode, string> = {
  manual: 'li.position ASC',
  added: 'li.added_at DESC, li.position ASC',
  year: 't.year DESC NULLS LAST, li.position ASC',
  rating: 't.tmdb_rating DESC NULLS LAST, li.position ASC',
  name: 't.name COLLATE NOCASE ASC',
};

export interface ItemRow {
  tmdb_id: number;
  media_type: MediaType;
  position: number;
  added_at: number;
  imdb_id: string | null;
  name: string | null;
  year: number | null;
  poster_path: string | null;
  overview: string | null;
  certification: string | null;
  tmdb_rating: number | null;
}

export function listItems(
  l: ListRow,
  opts: { mediaType?: MediaType; requireImdb?: boolean; limit?: number; offset?: number } = {},
): ItemRow[] {
  const where = ['li.list_id = ?', 'li.hidden = 0'];
  const args: (string | number)[] = [l.id];
  if (opts.mediaType) {
    where.push('li.media_type = ?');
    args.push(opts.mediaType);
  }
  if (opts.requireImdb) where.push('t.imdb_id IS NOT NULL');
  let sql = `SELECT li.tmdb_id, li.media_type, li.position, li.added_at, t.imdb_id, t.name, t.year,
                    t.poster_path, t.overview, t.certification, t.tmdb_rating
             FROM list_items li LEFT JOIN titles t ON t.tmdb_id = li.tmdb_id AND t.media_type = li.media_type
             WHERE ${where.join(' AND ')} ORDER BY ${ORDER_BY[l.sort_mode] ?? ORDER_BY.manual}`;
  if (opts.limit !== undefined) {
    sql += ' LIMIT ? OFFSET ?';
    args.push(opts.limit, opts.offset ?? 0);
  }
  return db().prepare(sql).all(...args) as ItemRow[];
}

export function countStremioItems(l: ListRow, mediaType: MediaType): number {
  return (
    db()
      .prepare(
        `SELECT COUNT(*) AS n FROM list_items li JOIN titles t ON t.tmdb_id = li.tmdb_id AND t.media_type = li.media_type
         WHERE li.list_id = ? AND li.hidden = 0 AND li.media_type = ? AND t.imdb_id IS NOT NULL`,
      )
      .get(l.id, mediaType) as { n: number }
  ).n;
}

// ---------- Export / import ----------

export interface ListExport {
  format: 'stremio-personal-lists/1';
  name: string;
  sortMode: SortMode;
  showOnHome: boolean;
  seasonStart: string | null;
  seasonEnd: string | null;
  items: { tmdbId: number; mediaType: MediaType; imdbId: string | null; name: string | null; year: number | null }[];
}

export function exportList(id: number): ListExport {
  const l = getList(id);
  return {
    format: 'stremio-personal-lists/1',
    name: l.name,
    sortMode: l.sort_mode,
    showOnHome: !!l.show_on_home,
    seasonStart: l.season_start,
    seasonEnd: l.season_end,
    items: listItems({ ...l, sort_mode: 'manual' }).map((i) => ({
      tmdbId: i.tmdb_id,
      mediaType: i.media_type,
      imdbId: i.imdb_id,
      name: i.name,
      year: i.year,
    })),
  };
}

export function parseExport(data: any): ListExport {
  if (!data || typeof data !== 'object' || typeof data.name !== 'string' || !Array.isArray(data.items)) {
    throw new ListError('Not a list export file');
  }
  const items = data.items
    .filter((i: any) => Number.isInteger(i?.tmdbId) && (i.mediaType === 'movie' || i.mediaType === 'series'))
    .map((i: any) => ({ tmdbId: i.tmdbId, mediaType: i.mediaType, imdbId: i.imdbId ?? null, name: i.name ?? null, year: i.year ?? null }));
  return {
    format: 'stremio-personal-lists/1',
    name: data.name,
    sortMode: SORT_MODES.includes(data.sortMode) ? data.sortMode : 'manual',
    showOnHome: data.showOnHome !== false,
    seasonStart: typeof data.seasonStart === 'string' ? data.seasonStart : null,
    seasonEnd: typeof data.seasonEnd === 'string' ? data.seasonEnd : null,
    items,
  };
}

export function importList(data: ListExport): ListRow {
  const l = createList({
    name: uniqueName(data.name),
    sortMode: data.sortMode,
    showOnHome: data.showOnHome,
    seasonStart: data.seasonStart,
    seasonEnd: data.seasonEnd,
  });
  addItems(l.id, data.items);
  return l;
}
