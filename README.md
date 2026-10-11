# Personal Stremio Lists

Self-hosted Stremio addon with a web UI for building household movie and TV lists from TMDB. See `Personal Stremio Lists Addon PRD.md` for the full plan.

Built so far:

- **Phase 1:** Library and custom lists, the browse/multiselect builder, paste import, seasonal lists, and the addon's manifest and catalogs.
- **Phase 2:** row ordering, a Trending row with a streaming-service filter, smart lists saved from Browse filters, and Sync to Stremio.

Suggestions (phase 3) are not built yet.

## Deploy with Portainer

1. In Portainer, add a stack from this Git repo using `docker-compose.yml`. The image is built on the host from the repo (`pull_policy: build`), so leave "Re-pull image" off; there's nothing in a registry to pull.
2. Set environment variables on the stack (see `.env.example`):
   - `TMDB_API_KEY`: free key from https://www.themoviedb.org/settings/api (the v3 key or the v4 read access token both work)
   - `ADMIN_PASSWORD`: web UI password (only used on first run; change it later in Settings)
   - `LISTS_HOST`: the public hostname, e.g. `lists.bearcatbox.xyz`
   - `TRAEFIK_NETWORK`: the existing Docker network Traefik is on (default `proxy`)
   - `TZ`: defaults to `America/New_York`
3. The stack's Traefik labels match the other homelab services: `http` redirects to `https`, which serves `LISTS_HOST` with the `http` certresolver and forwards to port 7000. Make sure the cloudflared tunnel sends that hostname to Traefik, the same way as your other services.
4. Open the hostname, log in, and go to **Settings → Install in Stremio**.

If `TMDB_API_KEY` or `ADMIN_PASSWORD` is left blank, the first visit shows a setup form for them instead.

Data lives in the `lists-data` volume at `/data`: `lists.db` plus nightly backups in `/data/backups` (kept 14 days). `GET /health` is available for uptime checks.

## How lists show up in Stremio

- Each list becomes up to two rows, one for movies and one for series. Rows with no items are left out.
- **My lists** sets the row order (drag ⋮⋮) and whether each list's movie and series rows sit together or all movie rows come first. Rows from other addons are ordered by Stremio's addon order, which Stremio itself can't change; community tools like Stremio Addon Manager can.
- Titles without an IMDb ID are flagged in the web UI and skipped in Stremio. Open the title's info drawer to enter one by hand.
- Turning off **Home** for a list keeps it in Discover only.
- Seasonal lists show only between their dates. After the end date they move to **Archived**; set new dates to bring them back.
- **Trending** shows the most popular titles this week on each streaming service in the US (TMDB discover filtered by watch provider, refreshed every 6 hours). The row has a filter for each service plus All; pick which services appear in Settings.
- **Smart lists** are saved from a set of Browse filters (Browse → Filters → Save as smart list). They refresh daily, keep the most popular N titles, and can't be edited title by title, but you can hide titles from them.
- Stremio caches the addon's list of rows. Item changes in an existing row show within about five minutes. New, renamed, reordered or newly in-season rows need either the **Stremio account connected** in Settings, which pushes the change to the account's installed addons automatically, or a reinstall. Devices pick up a pushed change the next time Stremio refreshes its addons, usually on restart.

The Stremio connection uses Stremio's unofficial account API (`api.strem.io`). The password is used once to get a session key and is not stored. If that API changes, sync stops working and the UI shows the error; reinstalling the addon still works.

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
