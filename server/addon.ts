import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSetting, type MediaType } from './db.js';
import { allLists, countStremioItems, getListBySlug, isInSeason, listItems, type ListRow } from './lists.js';
import { IMAGE_BASE } from './tmdb.js';

export const PAGE_SIZE = 100;
const TYPES: MediaType[] = ['movie', 'series'];
/** Lists that exist for internal use and never become Stremio rows. */
const HIDDEN_SYSTEM = new Set(['watched']);

function visibleLists(): ListRow[] {
  return allLists().filter((l) => !(l.system_key && HIDDEN_SYSTEM.has(l.system_key)) && isInSeason(l));
}

export function buildManifest() {
  const catalogs: any[] = [];
  for (const l of visibleLists()) {
    for (const type of TYPES) {
      if (countStremioItems(l, type) === 0) continue;
      catalogs.push({
        type,
        id: `${l.slug}-${type}`,
        name: l.name,
        // A required extra keeps a catalog off the home board, so it only shows in Discover.
        extra: l.show_on_home
          ? [{ name: 'skip' }]
          : [{ name: 'genre', options: [l.name], isRequired: true }, { name: 'skip' }],
      });
    }
  }
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
  return listItems(l, { mediaType: type, requireImdb: true, limit: PAGE_SIZE, offset: skip }).map((i) => ({
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
