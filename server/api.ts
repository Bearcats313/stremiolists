import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { getSetting, newToken, setSetting, type MediaType } from './db.js';
import {
  createSession,
  destroySession,
  hasPassword,
  isLoggedIn,
  loginThrottled,
  recordLoginFailure,
  setPassword,
  verifyPassword,
} from './auth.js';
import { extractEntries, fetchListText, matchLines, resolveEntries } from './importer.js';
import { historyStatus, syncWatchHistory } from './history.js';
import { refreshSuggestions, setCertCaps, suggestionsStatus } from './suggestions.js';
import {
  addItems,
  allLists,
  createList,
  deleteList,
  duplicateList,
  exportList,
  findOrCreateByName,
  getList,
  importList,
  ListError,
  listItems,
  parseExport,
  removeItems,
  reorderItems,
  toSummary,
  transferItems,
  updateList,
  type AddReport,
  type ListInput,
  hiddenItems,
  reorderLists,
} from './lists.js';
import { ensureTitles, getTitle, insertStub, listMembership, setManualImdbId, type TitleRef } from './titles.js';
import {
  discoverParams,
  fetchDetails,
  MOVIE_CERTS,
  SERVICES,
  summarize,
  TmdbError,
  tmdbGet,
  tmdbKey,
  testTmdbKey,
  TTL,
  TV_CERTS,
  tmdbType,
  type DiscoverFilters,
  type TitleSummary,
} from './tmdb.js';
import { upsertTitle } from './titles.js';
import { rowGrouping } from './addon.js';
import { parseSmartQuery, refreshSmartList, setHidden, smartRefreshedAt } from './smart.js';
import {
  connectWithKey,
  disconnectStremio,
  scheduleAutoSync,
  StremioError,
  stremioLogin,
  stremioStatus,
  syncToStremio,
  verifyAuthKey,
} from './stremio.js';
import { enabledServices, refreshTrending, setEnabledServices, trendingItems, trendingOptions } from './trending.js';
import type { ItemRow } from './lists.js';

const MAX_SELECTION = 500;

function asType(v: unknown): MediaType {
  if (v === 'movie' || v === 'series') return v;
  throw new ListError('type must be movie or series');
}

function asRefs(v: unknown): TitleRef[] {
  if (!Array.isArray(v)) throw new ListError('items must be an array');
  if (v.length > MAX_SELECTION) throw new ListError(`At most ${MAX_SELECTION} titles at once`);
  return v.map((i: any) => {
    const tmdbId = Number(i?.tmdbId);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw new ListError('Invalid tmdbId');
    return { tmdbId, mediaType: asType(i?.mediaType) };
  });
}

const numList = (v: unknown) =>
  typeof v === 'string' && v ? v.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : undefined;
const strList = (v: unknown) => (typeof v === 'string' && v ? v.split(',').filter(Boolean) : undefined);
const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v) || undefined);

function withBadges(results: TitleSummary[]) {
  const m = listMembership(results);
  return results.map((r) => ({ ...r, inLists: m.get(`${r.mediaType}:${r.tmdbId}`) ?? [] }));
}

function page(res: any, type?: MediaType) {
  const results = (res.results ?? []).map((r: any) => summarize(r, type)).filter(Boolean) as TitleSummary[];
  return {
    page: res.page ?? 1,
    totalPages: Math.min(res.total_pages ?? 1, 500),
    results: withBadges(results),
  };
}

export function installUrls(req: FastifyRequest) {
  const base = config.publicUrl || `${req.protocol}://${req.host}`;
  const manifest = `${base}/${getSetting('addon_token')}/manifest.json`;
  return { manifestUrl: manifest, stremioUrl: manifest.replace(/^https?:\/\//, 'stremio://') };
}

const itemJson = (i: ItemRow) => ({
  tmdbId: i.tmdb_id,
  mediaType: i.media_type,
  name: i.name,
  year: i.year,
  posterPath: i.poster_path,
  rating: i.tmdb_rating,
  imdbId: i.imdb_id,
  addedAt: i.added_at,
});

export function registerApiRoutes(app: FastifyInstance) {
  const log = (msg: string, err?: unknown) => (err ? app.log.error({ err }, msg) : app.log.info(msg));

  // Any successful change might alter the Stremio rows; push them if an account is connected.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && req.url.startsWith('/api/') && reply.statusCode < 400) scheduleAutoSync(log);
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ListError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof StremioError) return reply.code(502).send({ error: err.message });
    if (err instanceof TmdbError) {
      return reply.code(502).send({ error: err.status === 401 ? 'TMDB rejected the API key' : err.message });
    }
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: err.message });
    app.log.error(err);
    return reply.code(err.statusCode && err.statusCode < 600 ? err.statusCode : 500).send({ error: 'Server error' });
  });

  // ---------- Setup and auth (open) ----------

  app.get('/api/status', async (req) => ({
    setupNeeded: !hasPassword() || !tmdbKey(),
    needsPassword: !hasPassword(),
    needsTmdbKey: !tmdbKey(),
    loggedIn: isLoggedIn(req),
  }));

  app.post<{ Body: { password?: string; tmdbApiKey?: string } }>('/api/setup', async (req, reply) => {
    // Setup is only open while something is missing; afterwards changes go through settings.
    if (hasPassword() && tmdbKey()) return reply.code(409).send({ error: 'Already set up' });
    const { password, tmdbApiKey } = req.body ?? {};
    if (!hasPassword()) {
      if (!password || password.length < 8) return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      setPassword(password);
    } else if (!isLoggedIn(req) && !verifyPassword(password ?? '', getSetting('admin_password_hash'))) {
      return reply.code(401).send({ error: 'Enter the admin password' });
    }
    if (!tmdbKey()) {
      const key = tmdbApiKey?.trim();
      if (!key) return reply.code(400).send({ error: 'TMDB API key is required' });
      if (!(await testTmdbKey(key))) return reply.code(400).send({ error: 'TMDB rejected that API key' });
      setSetting('tmdb_api_key', key);
    }
    createSession(req, reply);
    return { ok: true };
  });

  app.post<{ Body: { password?: string } }>('/api/login', async (req, reply) => {
    if (loginThrottled(req.ip)) return reply.code(429).send({ error: 'Too many attempts, wait a moment' });
    if (!verifyPassword(req.body?.password ?? '', getSetting('admin_password_hash'))) {
      recordLoginFailure(req.ip);
      return reply.code(401).send({ error: 'Wrong password' });
    }
    createSession(req, reply);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    destroySession(req, reply);
    return { ok: true };
  });

  // ---------- Everything below requires a session ----------

  app.register(async (priv) => {
    priv.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isLoggedIn(req)) return reply.code(401).send({ error: 'Not logged in' });
    });

    // Settings
    priv.get('/api/settings', async (req) => ({
      ...installUrls(req),
      addonToken: getSetting('addon_token'),
      region: getSetting('region') || 'US',
      tmdbKeyFromEnv: !getSetting('tmdb_api_key') && !!config.envTmdbApiKey,
      lastBackup: getSetting('last_backup'),
      rowGrouping: rowGrouping(),
      enabledServices: enabledServices(),
      allServices: SERVICES.map((s) => s.name),
      trendingRefreshedAt: Number(getSetting('trending_refreshed_at')) || null,
    }));

    priv.post<{ Body: { rowGrouping?: string; enabledServices?: string[] } }>('/api/settings/rows', async (req) => {
      const b = req.body ?? {};
      if (b.rowGrouping !== undefined) setSetting('row_grouping', b.rowGrouping === 'type' ? 'type' : 'list');
      if (Array.isArray(b.enabledServices)) {
        setEnabledServices(b.enabledServices.map(String));
        // Rebuild the per-service rankings in the background; it takes a minute on a cold cache.
        void refreshTrending().catch((err) => log('Trending refresh failed', err));
      }
      return { rowGrouping: rowGrouping(), enabledServices: enabledServices() };
    });

    // Stremio account, for pushing manifest changes without reinstalling
    priv.get('/api/stremio', async () => stremioStatus());

    priv.post<{ Body: { email?: string; password?: string; authKey?: string } }>('/api/stremio/connect', async (req, reply) => {
      const b = req.body ?? {};
      if (b.authKey?.trim()) {
        const key = b.authKey.trim().replace(/^"|"$/g, '');
        await verifyAuthKey(key);
        connectWithKey(key, null);
      } else if (b.email?.trim() && b.password) {
        await stremioLogin(b.email.trim(), b.password);
      } else {
        return reply.code(400).send({ error: 'Enter your Stremio email and password, or an auth key' });
      }
      await syncToStremio().catch(() => {}); // the status shows any error
      // Pull watch history and build suggestions in the background.
      void syncWatchHistory()
        .then(() => refreshSuggestions())
        .catch((err) => log('Watch history sync failed', err));
      return stremioStatus();
    });

    priv.get('/api/dashboard', async () => ({
      stremio: stremioStatus(),
      history: historyStatus(),
      suggestions: suggestionsStatus(),
      trendingRefreshedAt: Number(getSetting('trending_refreshed_at')) || null,
      lastBackup: getSetting('last_backup'),
    }));

    priv.post<{ Body: { movie?: string | null; series?: string | null } }>('/api/settings/suggestions', async (req) => {
      setCertCaps(req.body ?? {});
      void refreshSuggestions().catch((err) => log('Suggestions refresh failed', err));
      return suggestionsStatus();
    });

    priv.post('/api/stremio/disconnect', async () => {
      disconnectStremio();
      return stremioStatus();
    });

    priv.post('/api/stremio/sync', async () => {
      const r = await syncToStremio();
      return { ...stremioStatus(), added: r.added };
    });

    priv.post<{ Body: { tmdbApiKey?: string; currentPassword?: string; newPassword?: string } }>(
      '/api/settings',
      async (req, reply) => {
        const b = req.body ?? {};
        if (b.tmdbApiKey !== undefined) {
          const key = b.tmdbApiKey.trim();
          if (!(await testTmdbKey(key))) return reply.code(400).send({ error: 'TMDB rejected that API key' });
          setSetting('tmdb_api_key', key);
        }
        if (b.newPassword !== undefined) {
          if (!verifyPassword(b.currentPassword ?? '', getSetting('admin_password_hash'))) {
            return reply.code(400).send({ error: 'Current password is wrong' });
          }
          if (b.newPassword.length < 8) return reply.code(400).send({ error: 'Password must be at least 8 characters' });
          setPassword(b.newPassword);
          createSession(req, reply);
        }
        return { ok: true };
      },
    );

    priv.post('/api/settings/regenerate-token', async (req) => {
      setSetting('addon_token', newToken());
      return { ...installUrls(req), addonToken: getSetting('addon_token') };
    });

    // Reference data for the filter panel
    priv.get<{ Querystring: { type?: string } }>('/api/meta/filters', async (req) => {
      const type = asType(req.query.type ?? 'movie');
      const genres = await tmdbGet(`/genre/${tmdbType(type)}/list`, {}, TTL.static);
      return {
        genres: genres.genres ?? [],
        certifications: type === 'movie' ? MOVIE_CERTS : TV_CERTS,
        services: SERVICES.map((s) => s.name),
      };
    });

    priv.get<{ Querystring: { q?: string } }>('/api/meta/keywords', async (req) => {
      const q = (req.query.q ?? '').trim();
      if (!q) return { results: [] };
      const res = await tmdbGet('/search/keyword', { query: q });
      return { results: (res.results ?? []).slice(0, 10).map((k: any) => ({ id: k.id, name: k.name })) };
    });

    priv.get('/api/meta/services', async () => ({ services: trendingOptions() }));

    // Browse: search, discover, trending/popular
    priv.get<{ Querystring: Record<string, string | undefined> }>('/api/browse', async (req) => {
      const q = req.query;
      const type = asType(q.type ?? 'movie');
      const pg = Math.min(Math.max(1, Number(q.page) || 1), 500);
      const t = tmdbType(type);

      if (q.q?.trim()) {
        return page(await tmdbGet(`/search/${t}`, { query: q.q.trim(), page: pg, include_adult: 'false' }), type);
      }
      const filters: DiscoverFilters = {
        genres: numList(q.genres),
        keywords: numList(q.keywords),
        yearFrom: num(q.yearFrom),
        yearTo: num(q.yearTo),
        certs: strList(q.certs),
        minRating: num(q.minRating),
        minVotes: num(q.minVotes),
        services: strList(q.services),
        sort: q.sort,
      };
      const hasFilters = Object.entries(filters).some(([k, v]) => k !== 'sort' && (Array.isArray(v) ? v.length : v));
      if (hasFilters) return page(await tmdbGet(`/discover/${t}`, discoverParams(type, filters, pg)), type);
      if (q.mode === 'popular') return page(await tmdbGet(`/${t}/popular`, { page: pg }), type);
      return page(await tmdbGet(`/trending/${t}/week`, { page: pg }, TTL.trending), type);
    });

    priv.get<{ Params: { type: string; id: string } }>('/api/title/:type/:id', async (req) => {
      const type = asType(req.params.type);
      const id = Number(req.params.id);
      const details = await fetchDetails(type, id);
      upsertTitle(details);
      const stored = getTitle({ tmdbId: id, mediaType: type });
      return {
        ...details,
        imdbId: stored?.imdb_id ?? details.imdbId,
        imdbIdManual: !!stored?.imdb_id_manual,
        inLists: listMembership([{ tmdbId: id, mediaType: type }]).get(`${type}:${id}`) ?? [],
      };
    });

    priv.put<{ Params: { type: string; id: string }; Body: { imdbId?: string | null } }>(
      '/api/title/:type/:id/imdb',
      async (req, reply) => {
        const ref = { tmdbId: Number(req.params.id), mediaType: asType(req.params.type) };
        const imdbId = req.body?.imdbId?.trim() || null;
        if (imdbId && !/^tt\d{5,}$/.test(imdbId)) return reply.code(400).send({ error: 'IMDb IDs look like tt0108160' });
        await ensureTitles([ref]);
        if (!getTitle(ref)) return reply.code(404).send({ error: 'Title not found' });
        setManualImdbId(ref, imdbId);
        if (!imdbId) upsertTitle(await fetchDetails(ref.mediaType, ref.tmdbId));
        return { imdbId: getTitle(ref)?.imdb_id ?? null };
      },
    );

    priv.get<{ Params: { type: string; id: string }; Querystring: { page?: string } }>(
      '/api/title/:type/:id/related',
      async (req) => {
        const type = asType(req.params.type);
        const t = tmdbType(type);
        const pg = Math.max(1, Number(req.query.page) || 1);
        const [rec, sim] = await Promise.all([
          tmdbGet(`/${t}/${req.params.id}/recommendations`, { page: pg }),
          tmdbGet(`/${t}/${req.params.id}/similar`, { page: pg }),
        ]);
        const seen = new Set<number>();
        const merged = [...(rec.results ?? []), ...(sim.results ?? [])].filter((r: any) => !seen.has(r.id) && seen.add(r.id));
        return page(
          { page: pg, total_pages: Math.max(rec.total_pages ?? 1, sim.total_pages ?? 1), results: merged },
          type,
        );
      },
    );

    // Import from MDBList or any list export: a link, or JSON/CSV/text containing IMDb or TMDB IDs
    priv.post<{ Body: { url?: string; text?: string } }>('/api/import/external', { bodyLimit: 6 * 1024 * 1024 }, async (req) => {
      let text = req.body?.text ?? '';
      if (req.body?.url?.trim()) {
        try {
          text = await fetchListText(req.body.url);
        } catch (err: any) {
          throw new ListError(`Couldn't load that link: ${err.message}`);
        }
      }
      const entries = extractEntries(text);
      if (!entries.length) throw new ListError('No IMDb or TMDB IDs found in that list');
      const results = await resolveEntries(entries);
      const badges = listMembership(results.flatMap((r) => (r.match ? [r.match] : [])));
      return {
        results: results.map((r) => ({
          ...r,
          match: r.match && { ...r.match, inLists: badges.get(`${r.match.mediaType}:${r.match.tmdbId}`) ?? [] },
        })),
      };
    });

    // Paste import
    priv.post<{ Body: { text?: string; type?: string } }>('/api/import/match', async (req) => {
      const type = req.body?.type === 'movie' || req.body?.type === 'series' ? req.body.type : 'any';
      const results = await matchLines(req.body?.text ?? '', type);
      const all = results.flatMap((r) => (r.match ? [r.match, ...r.alternates] : r.alternates));
      const badges = listMembership(all);
      const tag = (t: TitleSummary | null) => t && { ...t, inLists: badges.get(`${t.mediaType}:${t.tmdbId}`) ?? [] };
      return { results: results.map((r) => ({ ...r, match: tag(r.match), alternates: r.alternates.map(tag) })) };
    });

    // Lists
    priv.get('/api/lists', async () => ({ lists: allLists().map(toSummary) }));

    priv.post<{ Body: { ids?: unknown } }>('/api/lists/order', async (req) => {
      if (!Array.isArray(req.body?.ids)) throw new ListError('ids must be an array');
      reorderLists(req.body.ids.map(Number));
      return { lists: allLists().map(toSummary) };
    });

    priv.post<{ Body: { name?: string; query?: unknown; limit?: number; showOnHome?: boolean } }>(
      '/api/lists/smart',
      async (req) => {
        const query = parseSmartQuery(req.body?.query);
        const limit = Math.round(Number(req.body?.limit ?? 50));
        if (!(limit >= 1 && limit <= 500)) throw new ListError('Result cap must be between 1 and 500');
        const l = createList({
          name: String(req.body?.name ?? ''),
          showOnHome: req.body?.showOnHome,
          smartQuery: query,
          smartLimit: limit,
        });
        await refreshSmartList(l);
        return toSummary(getList(l.id));
      },
    );

    priv.post<{ Params: { id: string } }>('/api/lists/:id/refresh', async (req) => {
      const l = getList(Number(req.params.id));
      if (l.system_key === 'trending') await refreshTrending();
      else if (l.system_key === 'suggestions') {
        // Fresh history first; if Stremio is unreachable, suggest from what's already known.
        if (stremioStatus().connected) await syncWatchHistory().catch(() => {});
        await refreshSuggestions();
      } else await refreshSmartList(l);
      return toSummary(getList(l.id));
    });

    priv.post<{ Params: { id: string }; Body: { items?: unknown; hidden?: boolean } }>(
      '/api/lists/:id/hide',
      async (req) => {
        const id = Number(req.params.id);
        const hidden = req.body?.hidden !== false;
        setHidden(id, asRefs(req.body?.items), hidden);
        if (!hidden) await refreshSmartList(getList(id));
        return toSummary(getList(id));
      },
    );
    priv.post<{ Body: ListInput }>('/api/lists', async (req) =>
      toSummary(createList({ ...(req.body ?? {}), name: String(req.body?.name ?? '') })),
    );

    priv.patch<{ Params: { id: string }; Body: ListInput }>('/api/lists/:id', async (req) =>
      toSummary(updateList(Number(req.params.id), req.body ?? {})),
    );

    priv.delete<{ Params: { id: string } }>('/api/lists/:id', async (req) => {
      deleteList(Number(req.params.id));
      return { ok: true };
    });

    priv.post<{ Params: { id: string } }>('/api/lists/:id/duplicate', async (req) =>
      toSummary(duplicateList(Number(req.params.id))),
    );

    priv.get<{ Params: { id: string }; Querystring: { service?: string } }>('/api/lists/:id', async (req) => {
      const l = getList(Number(req.params.id));
      if (l.system_key === 'trending') {
        const service = trendingOptions().includes(req.query.service ?? '') ? req.query.service! : 'All';
        return {
          list: toSummary(l),
          items: trendingItems(service).map(itemJson),
          services: trendingOptions(),
          service,
          refreshedAt: Number(getSetting('trending_refreshed_at')) || null,
        };
      }
      return {
        list: toSummary(l),
        items: listItems(l).map(itemJson),
        hiddenItems: l.kind === 'smart' ? hiddenItems(l.id).map(itemJson) : [],
        refreshedAt:
          l.kind === 'smart' ? smartRefreshedAt(l.id) : l.system_key === 'suggestions' ? suggestionsStatus().refreshedAt : null,
        suggestions: l.system_key === 'suggestions' ? { ...suggestionsStatus(), history: historyStatus() } : undefined,
      };
    });

    priv.post<{ Body: { items?: unknown; listIds?: number[]; newListName?: string } }>(
      '/api/lists/add',
      async (req, reply) => {
        const refs = asRefs(req.body?.items);
        const listIds = [...new Set((req.body?.listIds ?? []).map(Number))];
        const newName = req.body?.newListName?.trim();
        if (newName) listIds.push(findOrCreateByName(newName).id);
        if (!listIds.length) return reply.code(400).send({ error: 'Pick at least one list' });
        listIds.forEach(getList); // 404 before doing any TMDB work

        const failed = await ensureTitles(refs);
        const failedKeys = new Set(failed.map((f) => `${f.mediaType}:${f.tmdbId}`));
        const ok = refs.filter((r) => !failedKeys.has(`${r.mediaType}:${r.tmdbId}`));
        const reports: AddReport[] = listIds.map((id) => addItems(id, ok));
        const missingImdb = ok.filter((r) => !getTitle(r)?.imdb_id).length;
        return { reports, failed: failed.length, missingImdb };
      },
    );

    priv.post<{ Params: { id: string }; Body: { items?: unknown } }>('/api/lists/:id/remove', async (req) => ({
      removed: removeItems(Number(req.params.id), asRefs(req.body?.items)),
    }));

    priv.post<{ Params: { id: string }; Body: { items?: unknown } }>('/api/lists/:id/reorder', async (req) => {
      reorderItems(Number(req.params.id), asRefs(req.body?.items));
      return { ok: true };
    });

    priv.post<{ Params: { id: string }; Body: { items?: unknown; targetListId?: number; mode?: string } }>(
      '/api/lists/:id/transfer',
      async (req) => {
        const mode = req.body?.mode === 'move' ? 'move' : 'copy';
        return transferItems(Number(req.params.id), Number(req.body?.targetListId), asRefs(req.body?.items), mode);
      },
    );

    priv.get<{ Params: { id: string } }>('/api/lists/:id/export', async (req, reply) => {
      const data = exportList(Number(req.params.id));
      const file = `${data.name.replace(/[^\w.-]+/g, '_')}.json`;
      reply.header('Content-Disposition', `attachment; filename="${file}"`);
      return data;
    });

    priv.post<{ Body: unknown }>('/api/lists/import', { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
      const data = parseExport(req.body);
      const failed = new Set((await ensureTitles(data.items)).map((f) => `${f.mediaType}:${f.tmdbId}`));
      for (const i of data.items) if (failed.has(`${i.mediaType}:${i.tmdbId}`)) insertStub(i);
      return toSummary(importList(data));
    });
  });
}
