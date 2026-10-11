import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

// ---------- Mock TMDB ----------

const movies: Record<number, any> = {
  1: { id: 1, title: 'Hocus Pocus', release_date: '1993-07-16', imdb_id: 'tt0107120', poster_path: '/hp.jpg', vote_average: 6.9, vote_count: 3000 },
  2: { id: 2, title: 'Halloween', release_date: '1978-10-25', imdb_id: 'tt0077651', poster_path: '/h78.jpg', vote_average: 7.6, vote_count: 5000 },
  3: { id: 3, title: 'Halloween', release_date: '2018-10-18', imdb_id: 'tt1502407', poster_path: '/h18.jpg', vote_average: 6.5, vote_count: 4000 },
  4: { id: 4, title: 'Obscure Short', release_date: '2020-01-01', imdb_id: null, vote_average: 0, vote_count: 0 },
};
const shows: Record<number, any> = {
  1: { id: 1, name: 'Stranger Things', first_air_date: '2016-07-15', external_ids: { imdb_id: 'tt4574334' }, vote_average: 8.6, vote_count: 9000 },
};

const tmdb = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const send = (body: any, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.searchParams.get('api_key') !== 'good-key') return send({ status_message: 'Invalid API key' }, 401);
  let m;
  if (url.pathname === '/configuration') return send({});
  if ((m = url.pathname.match(/^\/movie\/(\d+)$/))) {
    const mv = movies[Number(m[1])];
    return mv ? send({ ...mv, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, certification: 'PG' }] }] }, genres: [] }) : send({}, 404);
  }
  if ((m = url.pathname.match(/^\/tv\/(\d+)$/))) {
    const s = shows[Number(m[1])];
    return s ? send({ ...s, genres: [] }) : send({}, 404);
  }
  if (url.pathname === '/search/multi' || url.pathname === '/search/movie') {
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    const hits = Object.values(movies)
      .filter((x) => x.title.toLowerCase().includes(q))
      .map((x) => ({ ...x, media_type: 'movie' }));
    return send({ page: 1, total_pages: 1, results: hits });
  }
  if (url.pathname === '/trending/movie/week') {
    return send({ page: 1, total_pages: 1, results: Object.values(movies) });
  }
  send({}, 404);
});

// ---------- App under test ----------

let app: Awaited<ReturnType<typeof import('../server/app.js').buildApp>>;
let token: string;
let cookie = '';

async function api(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: body as any, headers: { cookie } });
  const setCookie = res.headers['set-cookie'];
  if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

before(async () => {
  await new Promise<void>((r) => tmdb.listen(0, r));
  process.env.TMDB_BASE_URL = `http://127.0.0.1:${(tmdb.address() as AddressInfo).port}`;
  process.env.TMDB_API_KEY = '';
  const { openDb, getSetting } = await import('../server/db.js');
  const { buildApp } = await import('../server/app.js');
  openDb(':memory:');
  token = getSetting('addon_token')!;
  app = await buildApp({ webDir: '/nonexistent' });
});

after(async () => {
  await app.close();
  tmdb.close();
});

describe('setup and auth', () => {
  test('setup requires password and valid key', async () => {
    assert.equal((await api('GET', '/api/status')).body.setupNeeded, true);
    assert.equal((await api('GET', '/api/lists')).status, 401);
    assert.equal((await api('POST', '/api/setup', { password: 'short', tmdbApiKey: 'good-key' })).status, 400);
    assert.equal((await api('POST', '/api/setup', { password: 'longenough', tmdbApiKey: 'bad' })).status, 400);
    const ok = await api('POST', '/api/setup', { password: 'longenough', tmdbApiKey: 'good-key' });
    assert.equal(ok.status, 200);
    assert.equal((await api('GET', '/api/status')).body.loggedIn, true);
    assert.equal((await api('POST', '/api/setup', { password: 'x', tmdbApiKey: 'y' })).status, 409);
  });

  test('login and logout', async () => {
    await api('POST', '/api/logout');
    assert.equal((await api('GET', '/api/lists')).status, 401);
    assert.equal((await api('POST', '/api/login', { password: 'nope' })).status, 401);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await api('POST', '/api/login', { password: 'longenough' })).status, 200);
    assert.equal((await api('GET', '/api/lists')).status, 200);
  });
});

describe('lists and addon', () => {
  let halloweenId: number;

  test('system lists exist and cannot be deleted', async () => {
    const { lists } = (await api('GET', '/api/lists')).body;
    assert.deepEqual(
      lists.map((l: any) => l.systemKey).filter(Boolean),
      ['library', 'trending', 'suggestions', 'watched'],
    );
    const lib = lists.find((l: any) => l.systemKey === 'library');
    assert.equal((await api('DELETE', `/api/lists/${lib.id}`)).status, 400);
  });

  test('bulk add reports duplicates and routes by type', async () => {
    const items = [
      { tmdbId: 1, mediaType: 'movie' },
      { tmdbId: 2, mediaType: 'movie' },
      { tmdbId: 1, mediaType: 'series' },
      { tmdbId: 4, mediaType: 'movie' },
    ];
    const r1 = await api('POST', '/api/lists/add', { items, newListName: 'Halloween' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.reports[0].added, 4);
    assert.equal(r1.body.missingImdb, 1);
    halloweenId = r1.body.reports[0].listId;

    const r2 = await api('POST', '/api/lists/add', { items: items.slice(0, 2), listIds: [halloweenId] });
    assert.deepEqual([r2.body.reports[0].added, r2.body.reports[0].skipped], [0, 2]);

    const detail = (await api('GET', `/api/lists/${halloweenId}`)).body;
    assert.equal(detail.list.movieCount, 3);
    assert.equal(detail.list.seriesCount, 1);
  });

  test('manifest has one catalog per type, skipping titles without IMDb IDs', async () => {
    const m = (await api('GET', `/${token}/manifest.json`)).body;
    const ids = m.catalogs.map((c: any) => c.id);
    assert.deepEqual(ids, ['halloween-movie', 'halloween-series']);
    assert.deepEqual(m.resources, ['catalog']);

    const cat = await api('GET', `/${token}/catalog/movie/halloween-movie.json`);
    assert.equal(cat.headers['access-control-allow-origin'], '*');
    assert.equal(cat.headers['cache-control'], 'max-age=300');
    assert.deepEqual(cat.body.metas.map((x: any) => x.id), ['tt0107120', 'tt0077651']);
    assert.equal(cat.body.metas[0].poster, 'https://image.tmdb.org/t/p/w500/hp.jpg');

    const paged = await api('GET', `/${token}/catalog/movie/halloween-movie/skip=1.json`);
    assert.deepEqual(paged.body.metas.map((x: any) => x.id), ['tt0077651']);

    assert.equal((await api('GET', `/wrong/manifest.json`)).status, 404);
  });

  test('manual IMDb ID makes a title appear', async () => {
    assert.equal((await api('PUT', '/api/title/movie/4/imdb', { imdbId: 'bogus' })).status, 400);
    await api('PUT', '/api/title/movie/4/imdb', { imdbId: 'tt9999999' });
    const cat = await api('GET', `/${token}/catalog/movie/halloween-movie.json`);
    assert.equal(cat.body.metas.length, 3);
  });

  test('sort, reorder, remove', async () => {
    await api('PATCH', `/api/lists/${halloweenId}`, { sortMode: 'year' });
    let cat = await api('GET', `/${token}/catalog/movie/halloween-movie.json`);
    assert.deepEqual(cat.body.metas.map((x: any) => x.id), ['tt9999999', 'tt0107120', 'tt0077651']);

    await api('POST', `/api/lists/${halloweenId}/reorder`, {
      items: [{ tmdbId: 2, mediaType: 'movie' }, { tmdbId: 1, mediaType: 'movie' }],
    });
    cat = await api('GET', `/${token}/catalog/movie/halloween-movie.json`);
    assert.deepEqual(cat.body.metas.map((x: any) => x.id), ['tt0077651', 'tt0107120', 'tt9999999']);

    await api('POST', `/api/lists/${halloweenId}/remove`, { items: [{ tmdbId: 1, mediaType: 'series' }] });
    const m = (await api('GET', `/${token}/manifest.json`)).body;
    assert.deepEqual(m.catalogs.map((c: any) => c.id), ['halloween-movie']);
  });

  test('home toggle declares a required extra', async () => {
    await api('PATCH', `/api/lists/${halloweenId}`, { showOnHome: false });
    const m = (await api('GET', `/${token}/manifest.json`)).body;
    assert.equal(m.catalogs[0].extra[0].isRequired, true);
    await api('PATCH', `/api/lists/${halloweenId}`, { showOnHome: true });
  });

  test('seasonal lists hide outside their dates and archive after the end', async () => {
    const { today } = await import('../server/config.js');
    const t = today();
    const y = Number(t.slice(0, 4));
    // Future window: hidden but not archived.
    let r = await api('PATCH', `/api/lists/${halloweenId}`, { seasonStart: `${y + 1}-10-01`, seasonEnd: `${y + 1}-11-01` });
    assert.equal(r.body.archived, false);
    assert.equal(r.body.inSeason, false);
    assert.equal((await api('GET', `/${token}/manifest.json`)).body.catalogs.length, 0);
    assert.equal((await api('GET', `/${token}/catalog/movie/halloween-movie.json`)).body.metas.length, 0);
    // Past window: archived.
    r = await api('PATCH', `/api/lists/${halloweenId}`, { seasonStart: `${y - 1}-10-01`, seasonEnd: `${y - 1}-11-01` });
    assert.equal(r.body.archived, true);
    // Window covering today: back.
    r = await api('PATCH', `/api/lists/${halloweenId}`, { seasonStart: t, seasonEnd: `${y + 1}-01-01` });
    assert.equal(r.body.archived, false);
    assert.equal(r.body.inSeason, true);
    assert.equal((await api('PATCH', `/api/lists/${halloweenId}`, { seasonStart: t, seasonEnd: null })).status, 400);
  });

  test('copy, move, duplicate, export and import', async () => {
    const lists = (await api('GET', '/api/lists')).body.lists;
    const lib = lists.find((l: any) => l.systemKey === 'library');
    await api('POST', `/api/lists/${halloweenId}/transfer`, {
      items: [{ tmdbId: 2, mediaType: 'movie' }],
      targetListId: lib.id,
      mode: 'move',
    });
    assert.equal((await api('GET', `/api/lists/${lib.id}`)).body.list.movieCount, 1);
    assert.equal((await api('GET', `/api/lists/${halloweenId}`)).body.list.movieCount, 2);

    const dup = (await api('POST', `/api/lists/${halloweenId}/duplicate`)).body;
    assert.equal(dup.name, 'Halloween copy');
    assert.equal(dup.movieCount, 2);

    const exp = (await api('GET', `/api/lists/${halloweenId}/export`)).body;
    assert.equal(exp.items.length, 2);
    const imp = (await api('POST', '/api/lists/import', exp)).body;
    assert.equal(imp.name, 'Halloween 2');
    assert.equal(imp.movieCount, 2);

    assert.equal((await api('DELETE', `/api/lists/${dup.id}`)).status, 200);
  });
});

describe('paste import', () => {
  test('parses lines', async () => {
    const { parseLine } = await import('../server/importer.js');
    assert.deepEqual(parseLine('Hocus Pocus (1993)'), { line: 'Hocus Pocus (1993)', query: 'Hocus Pocus', year: 1993 });
    assert.equal(parseLine('Blade Runner 2049')!.year, null);
    assert.equal(parseLine('Wonder Woman 1984')!.query, 'Wonder Woman 1984');
    assert.equal(parseLine('3. Halloween [1978]')!.query, 'Halloween');
    assert.equal(parseLine('   '), null);
  });

  test('matches with confidence', async () => {
    const r = await api('POST', '/api/import/match', { text: 'Hocus Pocus (1993)\nHalloween\nHalloween (2018)\nNothing Here' });
    const [hp, h, h18, none] = r.body.results;
    assert.equal(hp.match.tmdbId, 1);
    assert.equal(hp.confident, true);
    assert.equal(h.confident, false, 'two exact-name matches without a year need a human');
    assert.equal(h.alternates.length, 1);
    assert.equal(h18.match.tmdbId, 3);
    assert.equal(h18.confident, true);
    assert.equal(none.match, null);
  });
});

describe('browse', () => {
  test('trending default view carries list badges', async () => {
    const r = await api('GET', '/api/browse?type=movie');
    assert.equal(r.status, 200);
    const hp = r.body.results.find((x: any) => x.tmdbId === 1);
    assert.ok(hp.inLists.includes('Halloween'));
  });
});
