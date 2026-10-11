# Personal Stremio Lists

Self-hosted Stremio addon with a web UI for building household movie and TV lists from TMDB. See `Personal Stremio Lists Addon PRD.md` for the full plan.

This is **Phase 1**: Library and custom lists, the browse/multiselect builder, paste import, seasonal lists, and the addon's manifest and catalogs. Trending, smart lists, Sync to Stremio (phase 2) and suggestions (phase 3) are not built yet.

## Deploy with Portainer

1. In Portainer, add a stack from this Git repo using `docker-compose.yml`.
2. Set environment variables on the stack:
   - `TMDB_API_KEY`: free key from https://www.themoviedb.org/settings/api (the v3 key or the v4 read access token both work)
   - `ADMIN_PASSWORD`: web UI password (only used on first run; change it later in Settings)
   - `PUBLIC_URL`: the HTTPS hostname on the Cloudflare tunnel, e.g. `https://lists.bearcatbox.xyz`
   - `TZ`: defaults to `America/New_York`
3. Point the Cloudflare tunnel hostname at `http://<host>:7000`.
4. Open the hostname, log in, and go to **Settings → Install in Stremio**.

If `TMDB_API_KEY` or `ADMIN_PASSWORD` is left blank, the first visit shows a setup form for them instead.

Data lives in the `lists-data` volume at `/data`: `lists.db` plus nightly backups in `/data/backups` (kept 14 days). `GET /health` is available for uptime checks.

## How lists show up in Stremio

- Each list becomes up to two rows, one for movies and one for series. Rows with no items are left out.
- Titles without an IMDb ID are flagged in the web UI and skipped in Stremio. Open the title's info drawer to enter one by hand.
- Turning off **Home** for a list keeps it in Discover only.
- Seasonal lists show only between their dates. After the end date they move to **Archived**; set new dates to bring them back.
- Stremio caches the addon's list of rows. Item changes in an existing list show within about five minutes, but a **new** list (or a list coming into season) needs the addon reinstalled until Sync to Stremio lands in phase 2.

## Development

```sh
npm install
TMDB_API_KEY=... DATA_DIR=./data npm run dev   # server on :7000, Vite UI on :5173
npm test                                        # server tests against a mock TMDB
npm run typecheck
npm run build && DATA_DIR=./data npm start
```

Layout:

- `server/`: Fastify app. `addon.ts` (Stremio routes), `api.ts` (admin API), `lists.ts`, `titles.ts`, `tmdb.ts` (client with SQLite cache), `importer.ts` (paste matching), `scheduler.ts` (archiving, cache cleanup, backups)
- `web/`: React + Vite UI
- `test/`: `node:test` suite

This product uses the TMDB API but is not endorsed or certified by TMDB.
