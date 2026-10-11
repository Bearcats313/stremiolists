import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

// ---------- Mock TMDB ----------
// Provider 8 (Netflix) has movies 101-103, provider 15 (Hulu) has 201-202. Unfiltered discover returns 1-5.

const PROVIDER_TITLES: Record<string, number[]> = { '8': [101, 102, 103], '15': [201, 202] };

const tmdb = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const send = (body: any, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const item = (id: number, tv = false) => ({
    id,
    [tv ? 'name' : 'title']: `${tv ? 'Show' : 'Movie'} ${id}`,
    [tv ? 'first_air_date' : 'release_date']: '2020-01-01',
    vote_average: 7,
    vote_count: 100,
    poster_path: `/${id}.jpg`,
  });
  let m;
  if (url.pathname === '/configuration') return send({});
  if ((m = url.pathname.match(/^\/discover\/(movie|tv)$/))) {
    const tv = m[1] === 'tv';
    const providers = url.searchParams.get('with_watch_providers');
    let ids = providers ? providers.split('|').flatMap((p) => PROVIDER_TITLES[p] ?? []) : [1, 2, 3, 4, 5];
    if (url.searchParams.get('with_genres') === '35') ids = [1, 2, 3, 4, 5, 6, 7];
    return send({ page: 1, total_pages: 1, results: ids.map((id) => item(id, tv)) });
  }
  if ((m = url.pathname.match(/^\/(movie|tv)\/(\d+)$/))) {
    const tv = m[1] === 'tv';
    const id = Number(m[2]);
    return send({ ...item(id, tv), imdb_id: tv ? undefined : `tt${1000000 + id}`, external_ids: { imdb_id: `tt${(tv ? 2000000 : 1000000) + id}` }, genres: [] });
  }
  send({}, 404);
});

// ---------- Mock Stremio API ----------

const stremioState = {
  addons: [{ transportUrl: 'https://v3-cinemeta.strem.io/manifest.json', transportName: '', manifest: { id: 'com.linvo.cinemeta' }, flags: { official: true } }] as any[],
  sets: 0,
};

const stremio = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const send = (b: any) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(b));
  };
  if (req.url === '/api/login') {
    if (body.password !== 'stremio-pass') return send({ error: { message: 'Wrong password', code: 3 } });
    return send({ result: { authKey: 'AUTH123', user: { email: body.email } } });
  }
  if (body.authKey !== 'AUTH123') return send({ error: { message: 'Session does not exist', code: 1 } });
  if (req.url === '/api/addonCollectionGet') return send({ result: { addons: stremioState.addons } });
  if (req.url === '/api/addonCollectionSet') {
    stremioState.addons = body.addons;
    stremioState.sets++;
    return send({ result: { success: true } });
  }
  send({ error: { message: 'unknown' } });
});

// ---------- App ----------

let app: Awaited<ReturnType<typeof import('../server/app.js').buildApp>>;
let token: string;
let cookie = '';

async function api(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: body as any, headers: { cookie } });
  const setCookie = res.headers['set-cookie'];
  if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const manifest = async () => (await api('GET', `/${token}/manifest.json`)).body;
const catalogIds = async () => (await manifest()).catalogs.map((c: any) => c.id);

before(async () => {
  await new Promise<void>((r) => tmdb.listen(0, r));
  await new Promise<void>((r) => stremio.listen(0, r));
  process.env.TMDB_BASE_URL = `http://127.0.0.1:${(tmdb.address() as AddressInfo).port}`;
  process.env.STREMIO_API_URL = `http://127.0.0.1:${(stremio.address() as AddressInfo).port}/api`;
  process.env.PUBLIC_URL = 'https://lists.example.test';
  process.env.TMDB_API_KEY = 'good-key';
  const { openDb, getSetting } = await import('../server/db.js');
  const { buildApp } = await import('../server/app.js');
  openDb(':memory:');
  token = getSetting('addon_token')!;
  app = await buildApp({ webDir: '/nonexistent' });
  await api('POST', '/api/setup', { password: 'longenough' });
});

after(async () => {
  await app.close();
  tmdb.close();
  stremio.close();
});

describe('row order', () => {
  test('lists follow their saved order, grouped by list or by type', async () => {
    const a = (await api('POST', '/api/lists/add', { items: [{ tmdbId: 1, mediaType: 'movie' }, { tmdbId: 1, mediaType: 'series' }], newListName: 'Alpha' })).body.reports[0].listId;
    const b = (await api('POST', '/api/lists/add', { items: [{ tmdbId: 2, mediaType: 'movie' }, { tmdbId: 2, mediaType: 'series' }], newListName: 'Bravo' })).body.reports[0].listId;
    assert.deepEqual(await catalogIds(), ['alpha-movie', 'alpha-series', 'bravo-movie', 'bravo-series']);

    await api('POST', '/api/lists/order', { ids: [b, a] });
    assert.deepEqual(await catalogIds(), ['bravo-movie', 'bravo-series', 'alpha-movie', 'alpha-series']);

    await api('POST', '/api/settings/rows', { rowGrouping: 'type' });
    assert.deepEqual(await catalogIds(), ['bravo-movie', 'alpha-movie', 'bravo-series', 'alpha-series']);
    await api('POST', '/api/settings/rows', { rowGrouping: 'list' });

    const lists = (await api('GET', '/api/lists')).body.lists;
    assert.deepEqual(lists.slice(0, 2).map((l: any) => l.name), ['Bravo', 'Alpha']);
  });

  test('migration adds positions to an existing database', async () => {
    const Database = (await import('better-sqlite3')).default;
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lists-')), 'old.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE lists (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      kind TEXT NOT NULL, system_key TEXT UNIQUE, sort_mode TEXT NOT NULL DEFAULT 'manual', show_on_home INTEGER NOT NULL DEFAULT 1,
      season_start TEXT, season_end TEXT, archived INTEGER NOT NULL DEFAULT 0, smart_query TEXT, smart_limit INTEGER, created_at INTEGER NOT NULL);
      INSERT INTO lists (slug, name, kind, system_key, created_at) VALUES
        ('library', 'Library', 'system', 'library', 0), ('trending', 'Trending', 'system', 'trending', 0),
        ('suggestions', 'Suggestions', 'system', 'suggestions', 0), ('watched', 'Watched', 'system', 'watched', 0),
        ('zed', 'Zed', 'manual', NULL, 0), ('halloween', 'Halloween', 'manual', NULL, 0);`);
    old.close();
    const { openDb } = await import('../server/db.js');
    const d = openDb(file);
    const names = (d.prepare('SELECT name FROM lists ORDER BY position').all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(names, ['Library', 'Trending', 'Suggestions', 'Halloween', 'Zed', 'Watched']);
    d.close();
    openDb(':memory:'); // later tests don't use this db; restore a working handle
  });
});

describe('trending', () => {
  test('per-service rankings with a filter dropdown', async () => {
    // The previous test swapped the database; set up again.
    const { getSetting } = await import('../server/db.js');
    token = getSetting('addon_token')!;
    cookie = '';
    await api('POST', '/api/setup', { password: 'longenough' });

    await api('POST', '/api/settings/rows', { enabledServices: ['Netflix', 'Hulu'] });
    const trending = (await api('GET', '/api/lists')).body.lists.find((l: any) => l.systemKey === 'trending');
    const r = await api('POST', `/api/lists/${trending.id}/refresh`);
    assert.equal(r.status, 200);
    assert.equal(r.body.movieCount, 5);

    const m = await manifest();
    const cat = m.catalogs.find((c: any) => c.id === 'trending-movie');
    assert.deepEqual(cat.extra[0].options, ['All', 'Netflix', 'Hulu']);
    assert.equal(cat.extra[0].isRequired, false);

    const ids = async (extra: string) =>
      (await api('GET', `/${token}/catalog/movie/trending-movie${extra}.json`)).body.metas.map((x: any) => x.id);
    assert.deepEqual(await ids('/genre=Netflix'), ['tt1000101', 'tt1000102', 'tt1000103']);
    assert.deepEqual(await ids('/genre=Hulu'), ['tt1000201', 'tt1000202']);
    assert.equal((await ids('')).length, 5);
    assert.equal((await ids('/genre=All&skip=4')).length, 1);

    const detail = (await api('GET', `/api/lists/${trending.id}?service=Hulu`)).body;
    assert.equal(detail.items.length, 4); // 2 movies + 2 series
    assert.deepEqual(detail.services, ['All', 'Netflix', 'Hulu']);
  });
});

describe('smart lists', () => {
  let id: number;

  test('saving filters creates a refreshed list capped at the limit', async () => {
    assert.equal((await api('POST', '/api/lists/smart', { name: 'Empty', query: { type: 'movie' } })).status, 400);
    const r = await api('POST', '/api/lists/smart', {
      name: 'Family comedy',
      query: { type: 'movie', genres: [{ id: 35, name: 'Comedy' }] },
      limit: 4,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'smart');
    assert.equal(r.body.movieCount, 4);
    assert.equal(r.body.editable, false);
    id = r.body.id;
    assert.ok((await catalogIds()).includes('family-comedy-movie'));
  });

  test('hidden titles stay out after refresh and the cap backfills', async () => {
    await api('POST', `/api/lists/${id}/hide`, { items: [{ tmdbId: 1, mediaType: 'movie' }] });
    let detail = (await api('GET', `/api/lists/${id}`)).body;
    assert.equal(detail.hiddenItems.length, 1);
    await api('POST', `/api/lists/${id}/refresh`);
    detail = (await api('GET', `/api/lists/${id}`)).body;
    assert.deepEqual(detail.items.map((i: any) => i.tmdbId), [2, 3, 4, 5]);

    await api('POST', `/api/lists/${id}/hide`, { items: [{ tmdbId: 1, mediaType: 'movie' }], hidden: false });
    detail = (await api('GET', `/api/lists/${id}`)).body;
    assert.deepEqual(detail.items.map((i: any) => i.tmdbId), [1, 2, 3, 4]);
    assert.equal(detail.hiddenItems.length, 0);
  });

  test('items cannot be added or removed by hand', async () => {
    assert.equal((await api('POST', '/api/lists/add', { items: [{ tmdbId: 9, mediaType: 'movie' }], listIds: [id] })).status, 400);
    assert.equal((await api('POST', `/api/lists/${id}/remove`, { items: [{ tmdbId: 2, mediaType: 'movie' }] })).status, 400);
  });
});

describe('sync to Stremio', () => {
  test('connect, push the manifest, and update it in place', async () => {
    assert.equal((await api('POST', '/api/stremio/sync')).status, 502);
    assert.equal((await api('POST', '/api/stremio/connect', { email: 'a@b.c', password: 'nope' })).status, 502);

    const r = await api('POST', '/api/stremio/connect', { email: 'a@b.c', password: 'stremio-pass' });
    assert.equal(r.status, 200);
    assert.equal(r.body.connected, true);
    assert.equal(r.body.outOfSync, false);
    assert.equal(stremioState.addons.length, 2);
    const ours = stremioState.addons[1];
    assert.equal(ours.transportUrl, `https://lists.example.test/${token}/manifest.json`);
    assert.ok(ours.manifest.catalogs.some((c: any) => c.id === 'family-comedy-movie'));
    assert.equal(stremioState.addons[0].manifest.id, 'com.linvo.cinemeta', 'other addons are kept');

    // A new list makes the rows out of date until the next sync, which replaces our entry.
    await api('POST', '/api/lists/add', { items: [{ tmdbId: 3, mediaType: 'movie' }], newListName: 'Charlie' });
    assert.equal((await api('GET', '/api/stremio')).body.outOfSync, true);
    const s = await api('POST', '/api/stremio/sync');
    assert.equal(s.body.added, false);
    assert.equal(stremioState.addons.length, 2);
    assert.ok(stremioState.addons[1].manifest.catalogs.some((c: any) => c.id === 'charlie-movie'));

    await api('POST', '/api/stremio/disconnect');
    assert.equal((await api('GET', '/api/stremio')).body.connected, false);
  });
});
