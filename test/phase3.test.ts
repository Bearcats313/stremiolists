import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

// ---------- Mock TMDB ----------
// Movie N has IMDb ID tt00000NN (padded to 7 digits). Show 500 is tt0000500.
const imdb = (id: number) => `tt${String(id).padStart(7, '0')}`;
const CERTS: Record<number, string> = { 13: 'R' };
const RECS: Record<number, number[]> = { 1: [10, 11, 2], 2: [11, 12], 3: [13, 1], 4: [14] };

const tmdb = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const send = (body: any, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const movie = (id: number) => ({ id, title: `Movie ${id}`, release_date: '2010-01-01', vote_average: 7, vote_count: 50, poster_path: null });
  let m;
  if ((m = url.pathname.match(/^\/find\/tt(\d+)$/))) {
    const id = Number(m[1]);
    if (id === 500) return send({ movie_results: [], tv_results: [{ id: 500, name: 'Show 500', first_air_date: '2015-01-01' }] });
    return send({ movie_results: id > 0 && id < 400 ? [movie(id)] : [], tv_results: [] });
  }
  if ((m = url.pathname.match(/^\/movie\/(\d+)\/recommendations$/))) {
    return send({ page: 1, total_pages: 1, results: (RECS[Number(m[1])] ?? []).map(movie) });
  }
  if ((m = url.pathname.match(/^\/movie\/(\d+)$/))) {
    const id = Number(m[1]);
    const cert = CERTS[id] ?? 'PG';
    return send({ ...movie(id), imdb_id: imdb(id), genres: [], release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, certification: cert }] }] } });
  }
  if ((m = url.pathname.match(/^\/tv\/(\d+)$/))) {
    return send({ id: 500, name: 'Show 500', first_air_date: '2015-01-01', external_ids: { imdb_id: imdb(500) }, genres: [] });
  }
  send({}, 404);
});

// ---------- Mock Stremio ----------
const stremio = { failLibrary: false };
const LIBRARY = [
  { _id: imdb(1), type: 'movie', state: { timesWatched: 1, lastWatched: '2026-10-10T20:00:00Z' } },
  { _id: imdb(2), type: 'movie', state: { timeWatched: 5_000_000, duration: 6_000_000, lastWatched: '2026-10-09T20:00:00Z' } },
  { _id: imdb(3), type: 'movie', removed: true, state: { flaggedWatched: 1, lastWatched: '2026-10-08T20:00:00Z' } },
  { _id: imdb(4), type: 'movie', state: { timeWatched: 60_000, duration: 6_000_000 } }, // barely started
  { _id: imdb(500), type: 'series', state: { timeWatched: 1_200_000, lastWatched: '2026-10-01T20:00:00Z' } },
];
const stremioServer = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || '{}');
  const send = (b: any) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(b));
  };
  if (body.authKey !== 'KEY') return send({ error: { message: 'Session does not exist' } });
  if (req.url === '/api/addonCollectionGet') return send({ result: { addons: [] } });
  if (req.url === '/api/addonCollectionSet') return send({ result: { success: true } });
  if (req.url === '/api/datastoreGet') {
    if (stremio.failLibrary) return send({ error: { message: 'Library unavailable' } });
    return send({ result: LIBRARY });
  }
  send({ error: { message: 'unknown' } });
});

// ---------- App ----------
let app: Awaited<ReturnType<typeof import('../server/app.js').buildApp>>;
let token: string;
let cookie = '';
let ids: Record<string, number> = {};

async function api(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: body as any, headers: { cookie } });
  const setCookie = res.headers['set-cookie'];
  if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const suggestionIds = async () =>
  (await api('GET', `/api/lists/${ids.suggestions}`)).body.items.map((i: any) => i.tmdbId).sort((a: number, b: number) => a - b);

before(async () => {
  await new Promise<void>((r) => tmdb.listen(0, r));
  await new Promise<void>((r) => stremioServer.listen(0, r));
  process.env.TMDB_BASE_URL = `http://127.0.0.1:${(tmdb.address() as AddressInfo).port}`;
  process.env.STREMIO_API_URL = `http://127.0.0.1:${(stremioServer.address() as AddressInfo).port}/api`;
  process.env.PUBLIC_URL = 'https://lists.example.test';
  process.env.TMDB_API_KEY = 'good-key';
  const { openDb, getSetting } = await import('../server/db.js');
  const { buildApp } = await import('../server/app.js');
  openDb(':memory:');
  token = getSetting('addon_token')!;
  app = await buildApp({ webDir: '/nonexistent' });
  await api('POST', '/api/setup', { password: 'longenough' });
  for (const l of (await api('GET', '/api/lists')).body.lists) if (l.systemKey) ids[l.systemKey] = l.id;
});

after(async () => {
  await app.close();
  tmdb.close();
  stremioServer.close();
});

describe('watch history', () => {
  test('library items count as watched by Stremio flags, play counts, or progress', async () => {
    const { isWatched } = await import('../server/history.js');
    assert.equal(isWatched(LIBRARY[0] as any), true);
    assert.equal(isWatched(LIBRARY[1] as any), true);
    assert.equal(isWatched(LIBRARY[2] as any), true, 'removed from library but flagged watched');
    assert.equal(isWatched(LIBRARY[3] as any), false);
    assert.equal(isWatched(LIBRARY[4] as any), true);
  });
});

describe('suggestions', () => {
  test('built from Stremio history, excluding watched titles and the Library', async () => {
    await api('POST', '/api/lists/add', { items: [{ tmdbId: 12, mediaType: 'movie' }], listIds: [ids.library] });
    const r = await api('POST', '/api/stremio/connect', { authKey: 'KEY' });
    assert.equal(r.body.connected, true);

    const refreshed = await api('POST', `/api/lists/${ids.suggestions}/refresh`);
    assert.equal(refreshed.status, 200);
    // Watched: 1, 2, 3, show 500. Library: 12. Recommendations: 10, 11, 13, 1, 2, 12.
    assert.deepEqual(await suggestionIds(), [10, 11, 13]);

    const detail = (await api('GET', `/api/lists/${ids.suggestions}`)).body;
    assert.equal(detail.items[0].tmdbId, 11, 'recommended by two recent watches, so ranked first');
    assert.equal(detail.suggestions.history.count, 4);

    const m = (await api('GET', `/${token}/manifest.json`)).body;
    assert.ok(m.catalogs.some((c: any) => c.id === 'suggestions-movie'));
  });

  test('certification cap drops titles above it', async () => {
    await api('POST', '/api/settings/suggestions', { movie: 'PG-13' });
    await api('POST', `/api/lists/${ids.suggestions}/refresh`);
    assert.deepEqual(await suggestionIds(), [10, 11], '13 is rated R');
    await api('POST', '/api/settings/suggestions', { movie: null });
  });

  test('falls back to the manual Watched list when Stremio is unavailable', async () => {
    stremio.failLibrary = true;
    await api('POST', '/api/lists/add', { items: [{ tmdbId: 4, mediaType: 'movie' }], listIds: [ids.watched] });
    await api('POST', `/api/lists/${ids.suggestions}/refresh`);
    assert.ok((await suggestionIds()).includes(14), 'seeded from the Watched list');
    const dash = (await api('GET', '/api/dashboard')).body;
    assert.equal(dash.history.error, 'Library unavailable');
    assert.ok(dash.suggestions.refreshedAt);
    stremio.failLibrary = false;
  });
});

describe('external import', () => {
  test('finds IDs in MDBList, Trakt, and CSV shapes', async () => {
    const { extractEntries, normalizeListUrl } = await import('../server/importer.js');
    const mdb = extractEntries(
      JSON.stringify([
        { id: 603, rank: 1, title: 'The Matrix', imdb_id: 'tt0133093', mediatype: 'movie', release_year: 1999 },
        { id: 1399, rank: 2, title: 'Game of Thrones', imdb_id: 'tt0944947', mediatype: 'show', release_year: 2011 },
      ]),
    );
    assert.deepEqual(
      mdb.map((e) => [e.imdbId, e.mediaType, e.label]),
      [
        ['tt0133093', 'movie', 'The Matrix (1999)'],
        ['tt0944947', 'series', 'Game of Thrones (2011)'],
      ],
    );
    const combined = extractEntries(JSON.stringify({ movies: [{ imdb_id: 'tt0000001' }], shows: [{ imdb_id: 'tt0000500' }] }));
    assert.deepEqual(combined.map((e) => e.mediaType), ['movie', 'series']);
    const trakt = extractEntries(JSON.stringify([{ type: 'show', show: { title: 'X', ids: { imdb: 'tt0000500', tmdb: 500 } } }]));
    assert.deepEqual([trakt[0].imdbId, trakt[0].mediaType], ['tt0000500', 'series']);
    const csv = extractEntries('Const,Title\ntt0000001,Movie 1\ntt0000002,Movie 2\ntt0000001,dup');
    assert.deepEqual(csv.map((e) => e.imdbId), ['tt0000001', 'tt0000002']);

    assert.equal(normalizeListUrl('https://mdblist.com/lists/someone/halloween-classics'), 'https://mdblist.com/lists/someone/halloween-classics/json');
    assert.equal(normalizeListUrl('https://mdblist.com/lists/someone/halloween-classics/json'), 'https://mdblist.com/lists/someone/halloween-classics/json');
    assert.throws(() => normalizeListUrl('file:///etc/passwd'));
  });

  test('resolves IDs through TMDB for review', async () => {
    const r = await api('POST', '/api/import/external', {
      text: JSON.stringify([{ imdb_id: imdb(4), mediatype: 'movie' }, { imdb_id: imdb(500), mediatype: 'show' }, { imdb_id: 'tt9999999' }]),
    });
    assert.equal(r.status, 200);
    const [a, b, c] = r.body.results;
    assert.deepEqual([a.match.tmdbId, a.match.mediaType, a.confident], [4, 'movie', true]);
    assert.deepEqual([b.match.tmdbId, b.match.mediaType], [500, 'series']);
    assert.equal(c.match, null);
    assert.ok(a.match.inLists.includes('Watched'));

    assert.equal((await api('POST', '/api/import/external', { text: 'nothing here' })).status, 400);
  });

  test('paste import accepts bare IMDb IDs', async () => {
    const r = await api('POST', '/api/import/match', { text: `${imdb(2)}\n` });
    assert.equal(r.body.results[0].match.tmdbId, 2);
    assert.equal(r.body.results[0].confident, true);
  });
});
