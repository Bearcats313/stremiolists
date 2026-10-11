import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSetting, type MediaType } from './db.js';
import { allLists, countStremioItems, getListBySlug, isInSeason, listItems, type ItemRow, type ListRow } from './lists.js';
import { IMAGE_BASE } from './tmdb.js';
import { trendingItems, trendingOptions } from './trending.js';

export const PAGE_SIZE = 100;
const TYPES: MediaType[] = ['movie', 'series'];
/** Lists that exist for internal use and never become Stremio rows. */
const HIDDEN_SYSTEM = new Set(['watched']);

function visibleLists(): ListRow[] {
  return allLists().filter((l) => !(l.system_key && HIDDEN_SYSTEM.has(l.system_key)) && isInSeason(l));
}

function stremioCount(l: ListRow, type: MediaType) {
  return l.system_key === 'trending'
    ? trendingItems('All', { mediaType: type, requireImdb: true, limit: 1 }).length
    : countStremioItems(l, type);
}

export type RowGrouping = 'list' | 'type';
export function rowGrouping(): RowGrouping {
  return getSetting('row_grouping') === 'type' ? 'type' : 'list';
}

function catalogFor(l: ListRow, type: MediaType) {
  // A required extra keeps a catalog off the home board, so it only shows in Discover.
  const extra =
    l.system_key === 'trending'
      ? [{ name: 'genre', options: trendingOptions(), isRequired: !l.show_on_home }, { name: 'skip' }]
      : l.show_on_home
        ? [{ name: 'skip' }]
        : [{ name: 'genre', options: [l.name], isRequired: true }, { name: 'skip' }];
  return { type, id: `${l.slug}-${type}`, name: l.name, extra };
}

export function buildManifest() {
  const lists = visibleLists();
  // Stremio shows rows in manifest order: either each list's movie and series rows together,
  // or every movie row before every series row.
  const pairs =
    rowGrouping() === 'type'
      ? TYPES.flatMap((type) => lists.map((l) => [l, type] as const))
      : lists.flatMap((l) => TYPES.map((type) => [l, type] as const));
  const catalogs = pairs.filter(([l, type]) => stremioCount(l, type) > 0).map(([l, type]) => catalogFor(l, type));
  return {
    id: 'community.personal-lists',
    version: '0.1.0',
    name: 'Personal Lists',
    description: 'Household movie and TV lists',
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs,
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

export function parseExtra(extra: string | undefined): Record<string, string> {
  if (!extra) return {};
  return Object.fromEntries(new URLSearchParams(extra));
}

export function catalogMetas(type: string, catalogId: string, extra: Record<string, string>) {
  if (type !== 'movie' && type !== 'series') return [];
  const suffix = `-${type}`;
  if (!catalogId.endsWith(suffix)) return [];
  const l = getListBySlug(catalogId.slice(0, -suffix.length));
  if (!l || (l.system_key && HIDDEN_SYSTEM.has(l.system_key)) || !isInSeason(l)) return [];
  const skip = Math.max(0, Number.parseInt(extra.skip ?? '0', 10) || 0);
  let items: ItemRow[];
  if (l.system_key === 'trending') {
    const service = extra.genre && extra.genre !== 'All' ? extra.genre : 'All';
    items = trendingItems(service, { mediaType: type, requireImdb: true, limit: PAGE_SIZE, offset: skip });
  } else {
    items = listItems(l, { mediaType: type, requireImdb: true, limit: PAGE_SIZE, offset: skip });
  }
  return items.map((i) => ({
    id: i.imdb_id!,
    type,
    name: i.name ?? '',
    poster: i.poster_path ? `${IMAGE_BASE}/w500${i.poster_path}` : undefined,
    releaseInfo: i.year ? String(i.year) : undefined,
    description: i.overview || undefined,
  }));
}

function addonHeaders(reply: FastifyReply, maxAge: number) {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', '*');
  reply.header('Cache-Control', `max-age=${maxAge}`);
}

function tokenOk(token: string) {
  const expected = getSetting('addon_token');
  return !!expected && token === expected;
}

export function registerAddonRoutes(app: FastifyInstance) {
  app.options('/:token/*', async (_req, reply) => {
    addonHeaders(reply, 0);
    reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return reply.code(204).send();
  });

  app.get<{ Params: { token: string } }>('/:token/manifest.json', async (req, reply) => {
    addonHeaders(reply, 60);
    if (!tokenOk(req.params.token)) return reply.code(404).send({ error: 'Not found' });
    return buildManifest();
  });

  // /:token/catalog/:type/:id.json and /:token/catalog/:type/:id/:extra.json
  app.get<{ Params: { token: string } }>('/:token/catalog/*', async (req, reply) => {
    addonHeaders(reply, 300);
    if (!tokenOk(req.params.token)) return reply.code(404).send({ error: 'Not found' });
    // Use the raw path: the extra segment is itself query-string encoded ("genre=Disney%2B&skip=100").
    const path = req.url.split('?')[0];
    const rest = path.slice(path.indexOf('/catalog/') + '/catalog/'.length);
    if (!rest.endsWith('.json')) return reply.code(404).send({ error: 'Not found' });
    const parts = rest.slice(0, -'.json'.length).split('/');
    if (parts.length < 2 || parts.length > 3) return reply.code(404).send({ error: 'Not found' });
    try {
      const [type, id] = parts.slice(0, 2).map((p) => decodeURIComponent(p));
      return { metas: catalogMetas(type, id, parseExtra(parts[2])) };
    } catch {
      return reply.code(400).send({ error: 'Bad request' });
    }
  });
}
