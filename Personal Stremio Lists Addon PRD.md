# Personal Stremio Lists Addon PRD

Oct 11, 2026 · @Brian

## Overview

A self-hosted Stremio addon with a web UI for building and managing personal movie and TV lists, replacing Plex as the household's home screen. It runs in Docker on the homelab and costs nothing to operate.

Existing tools (Trakt, MDBList, TMDB lists) each cover part of this, but the useful parts sit behind paid tiers. Trakt's free tier caps personal lists and, since mid-2026, requires VIP to create an API application, which rules it out as a backend.

The addon shows four kinds of rows in Stremio: a personal library, custom lists (holidays and themes), trending across streaming services, and suggestions based on what the household has watched. Lists are built in a browser by searching TMDB, multiselecting titles, and adding them in bulk.

## Goals and non-goals

**Goals**

- Build lists quickly by browsing TMDB and adding many titles at once
- Show each list in Stremio as its own row, with movies and series in separate rows
- Keep a personal library list that replaces the Plex library as the main place to pick something to watch
- Provide a trending row across major streaming services, filterable by service
- Provide a suggestions row driven by the household's watch history
- Run entirely on free data sources and self-hosted infrastructure

**Non-goals**

- Streams or playback. Existing stream addons handle that; this addon only supplies catalogs.
- Title detail pages. Stremio's built-in Cinemeta metadata handles those from the IMDb ID.
- Multi-user accounts, sharing with other households, or public hosting
- Syncing with Trakt, Plex, or MDBList

## Users, devices, and environment

One household, one admin (Brian) who manages lists, and family members who only watch.

| Surface | Devices | Used for |
| --- | --- | --- |
| Stremio app | Google/Android TV, Fire TV Stick, iPad, phones | Watching; catalogs appear as rows on the home screen and Discover tab |
| Web UI | iPad, phone, desktop browser | Building and managing lists |

The web UI must be touch-friendly and usable at phone width, since much list building will happen on an iPad or phone.

Hosting is the existing homelab: Docker managed through Portainer Git-backed stacks, exposed through a Cloudflare tunnel.

## Catalogs in Stremio

Every list produces up to two Stremio catalogs, one of type `movie` and one of type `series`. A catalog with no items of that type is left out of the manifest so empty rows never appear.

| Catalog | Contents | Source | Refresh |
| --- | --- | --- | --- |
| Library | Titles the household wants on hand; the Plex replacement | Manual, via web UI | On edit |
| Custom lists | Holidays (Halloween, Christmas) and any theme | Manual, via web UI | On edit |
| Smart lists | Saved TMDB filter, e.g. PG family comedy rated 7.0+ | TMDB discover query | Every 24 hours |
| Trending | Top titles across streaming services this week | TMDB trending + watch providers | Every 6 hours |
| Suggestions | Titles similar to what the household watched, minus anything already watched, with an optional certification cap set in Settings (no cap by default) | TMDB recommendations seeded by watch history | Every 24 hours |

Catalog behavior:

- Each list has a display name and a toggle for whether it shows on the Stremio home screen or only in the Discover tab.
- Each list has a sort order chosen in the web UI (manual, date added, year, rating), and the catalog returns items in that order.
- The trending catalog exposes a filter dropdown in Stremio for streaming service (Netflix, Disney+, Max, Prime Video, Hulu, Apple TV+, Paramount+, Peacock) plus an "All" option.
- Lists can be marked seasonal with an active date range (Halloween: Oct 1 to Nov 1). Outside that range the list is hidden from Stremio. After the end date it moves to an Archived section in the web UI, where the start and end dates stay editable; setting new dates (or extending the end date) brings it back.
- Catalogs support paging with Stremio's `skip` parameter in pages of 100.

## Web UI list builder

The builder is designed for browsing first and committing second: the user explores TMDB, checks titles as they go, and adds the whole selection to one or more lists in a single action.

### Browse page

A top toggle switches between Movies and TV. Ways to find titles:

- **Search** by title, with results as you type
- **Filters** mapped to TMDB's discover endpoint: genre, keyword (e.g. "halloween", "christmas"), release year range, US certification (G, PG, PG-13, R for movies; TV-Y through TV-MA for series), minimum TMDB rating, minimum vote count, and streaming service
- **More like this** from any title, showing TMDB recommendations and similar titles
- **Trending and popular** as a default view when no search or filter is set

Results appear as a poster grid with title, year, and rating under each poster. The grid loads more as the user scrolls.

### Selecting

- Tapping a poster toggles a checkmark. A separate info button opens a detail drawer (overview, runtime, certification, where it streams) without changing the selection.
- A selection tray stays pinned to the bottom of the screen showing the count and small thumbnails. It persists across searches, filter changes, and the Movies/TV toggle.
- "Select all on this page" and "Clear selection" controls sit above the grid.
- Posters already in any list show a small badge naming the list(s).

### Adding to lists

- The tray's "Add" button opens a picker of existing lists with checkboxes, plus a "New list" field.
- Confirming adds every selected title to every checked list, skips duplicates, and reports the result ("Added 11 to Halloween; 2 were already there").
- Movies and series in one selection are routed automatically to the matching side of each list.

### Paste import

A text box accepts a block of titles, one per line, optionally with a year ("Hocus Pocus (1993)"). The app matches each line against TMDB and shows the matches as a pre-checked grid. Low-confidence matches are flagged with alternates to choose from. The user confirms, then adds to lists as above.

### Smart lists

Any filter combination on the browse page can be saved as a smart list with a name and a result cap (default 50). Smart lists refresh on a schedule and cannot be edited item by item, but individual titles can be hidden from them.

### List management

- Lists page showing each list with movie and series counts, seasonal dates, and home screen toggle
- Inside a list: poster grid with drag-to-reorder, multiselect remove, move or copy selected titles to another list, and sort options
- Rename, duplicate, and delete lists; delete requires confirmation
- Export and import a list as JSON for backup

## Data sources

TMDB supplies all title data, and the Stremio account supplies watch history. Trakt is not used.

| Source | Used for | Cost and limits | Notes |
| --- | --- | --- | --- |
| [TMDB API v3](https://developer.themoviedb.org/docs/getting-started) | Search, discover filters, trending, watch providers, recommendations, posters, IMDb ID lookup | Free for non-commercial use with attribution; about 40 requests per second per IP | Requires a free API key; show the TMDB attribution notice in the web UI footer |
| Stremio account library | Watch history for suggestions | Free | Unofficial API (`api.strem.io`, `datastoreGet` on `libraryItem`) using the account's auth key; may change without notice |
| Stremio account addon collection | Pushing an updated manifest after lists change | Free | Unofficial API (`addonCollectionGet` / `addonCollectionSet`); same auth key |
| Cinemeta (Stremio built-in) | Detail pages in Stremio | Free | No work needed; triggered by returning IMDb IDs |

Requirements:

- Every stored title keeps both its TMDB ID and IMDb ID. Stremio catalogs return IMDb IDs (`tt…`) so Cinemeta and stream addons recognize them. Titles with no IMDb ID are allowed in the web UI but flagged and excluded from Stremio catalogs.
- Cache TMDB responses in SQLite: title details for 7 days, search and discover results for 1 hour, trending for 6 hours.
- Watch provider data uses the US region.
- If the Stremio library call fails, suggestions fall back to a manual "Watched" list maintained in the web UI, and the dashboard shows the sync error.

## Data model

SQLite in a Docker volume. Starting schema for Claude Code to refine:

| Table | Key fields |
| --- | --- |
| `titles` | `tmdb_id`, `media_type` (movie, series), `imdb_id`, `name`, `year`, `poster_path`, `overview`, `certification`, `tmdb_rating`, `genres`, `cached_at` |
| `lists` | `id`, `slug`, `name`, `kind` (manual, smart, system), `sort_mode`, `show_on_home`, `season_start`, `season_end`, `smart_query` (JSON, smart lists only), `smart_limit`, `created_at` |
| `list_items` | `list_id`, `tmdb_id`, `media_type`, `position`, `added_at`, `hidden` (smart lists only) |
| `watch_history` | `imdb_id`, `media_type`, `last_watched_at`, `source` (stremio, manual) |
| `settings` | `tmdb_api_key`, `stremio_auth_key`, `admin_password_hash`, `addon_token`, `region`, `enabled_services` |
| `cache` | `key`, `payload`, `expires_at` |

System lists created on first run: Library, Trending, Suggestions, and Watched (manual fallback). System lists cannot be deleted. Lists also need an `archived` flag, and settings need `suggestion_max_certification` (null means no cap).

The primary key for a title is (`tmdb_id`, `media_type`), since TMDB reuses numeric IDs across movies and TV.

## Stremio addon requirements

The addon implements only the `catalog` resource. Because the catalog list changes whenever a list is added or renamed, the manifest is generated per request, so plain HTTP routes are preferred over the official SDK's static builder.

| Route | Returns |
| --- | --- |
| `GET /{addon_token}/manifest.json` | Manifest built from current lists |
| `GET /{addon_token}/catalog/{type}/{catalog_id}.json` | First page of metas |
| `GET /{addon_token}/catalog/{type}/{catalog_id}/{extra}.json` | Paged or filtered metas (`skip=100`, `genre=Netflix`) |

Manifest:

- `resources: ["catalog"]`, `types: ["movie", "series"]`, `idPrefixes: ["tt"]`
- One catalog entry per list per media type that has items, with `id` = `{list_slug}-{type}` and `name` = the list name
- Trending catalog declares `extra: [{name: "genre", options: [service names]}, {name: "skip"}]`
- Lists with `show_on_home` off are kept off the home board by declaring a required extra (e.g. a required `genre` with one option), which limits them to the Discover tab

Catalog response: `{ metas: [...] }`, each meta with `id` (IMDb ID), `type`, `name`, `poster` (TMDB image URL, w500), `releaseInfo` (year), `description`, and `imdbRating` when known.

Other requirements:

- Send CORS headers (`Access-Control-Allow-Origin: *`) on every addon route; Stremio clients fail silently without them.
- Set `Cache-Control: max-age=300` on catalogs so edits appear within about five minutes.
- The `addon_token` is a random string generated on first run and shown in the web UI with an "Install in Stremio" button (`stremio://` link) and a copyable HTTPS URL. Regenerating it invalidates the old install.
- Stremio clients cache the installed manifest. After list changes, a "Sync to Stremio" action pushes the new manifest to the account's addon collection so new rows appear without reinstalling. If that fails, the UI tells the user to reinstall.

## Architecture and deployment

One Docker container holds the addon routes, the web UI, a scheduler, and a SQLite volume, all reached through the existing Cloudflare tunnel.

&#91;embedded content: addon architecture · one container, two outside APIs\]

The web UI also calls TMDB directly for live browsing, through the same cache.

| Area | Decision |
| --- | --- |
| Stack | Node with TypeScript; one server process serving the addon routes, admin API, and built frontend. Fastify for the server, React with Vite for the web UI, and better-sqlite3 for storage. One language across the app, and most Stremio addon examples are JavaScript. |
| Container | One image, one service, internal port 7000, named volume at `/data`. Stack file lives in the Git repo Portainer deploys from. |
| Configuration | Environment variables for `TMDB_API_KEY`, `ADMIN_PASSWORD`, `PUBLIC_URL`, and `TZ=America/New_York`. Everything else lives in the settings table and is editable in the UI. |
| Exposure | A hostname on the existing Cloudflare tunnel, e.g. `lists.bearcatbox.xyz`. Stremio clients on TVs and phones require HTTPS, which the tunnel provides. |
| Auth | Web UI behind a password login with a session cookie. Addon routes stay open so Stremio can reach them, protected by the URL token. |
| Backups | Nightly SQLite backup to `/data/backups`, kept 14 days. |
| Health | `GET /health` for Portainer and uptime checks. |

## Phases and acceptance criteria

Phase 1 ships before Halloween so the Halloween list is usable this season.

1. **Phase 1: lists and builder**
   - Docker image runs under Portainer with a SQLite volume; first-run setup asks for the admin password and TMDB API key
   - Browse page with search, filters, Movies/TV toggle, multiselect tray, and add to lists
   - Paste import with TMDB matching
   - Library and custom lists with seasonal dates, sort, reorder, and remove
   - Addon serves manifest and catalogs; installing on a Google TV shows Library and Halloween as separate movie and series rows
   - Done when: 40 titles can be pasted, confirmed, and added to a Halloween list in under 3 minutes, and the row appears on a Fire TV Stick and an iPad
2. **Phase 2: trending and smart lists**
   - Trending catalog with the streaming service filter
   - Smart lists saved from browse filters, refreshed every 24 hours
   - Sync to Stremio pushes manifest changes
   - Done when: a new list appears on a TV without reinstalling, and trending filtered to Netflix returns only titles TMDB lists on Netflix US
3. **Phase 3: suggestions**
   - Stremio library sync for watch history, with the manual Watched list as fallback
   - Suggestions catalog that excludes watched titles and titles already in the Library
   - Dashboard showing last sync time and errors
   - Done when: after watching three titles in Stremio, the next refresh produces suggestions related to them and none of the three appear

## Risks and open questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Stremio's unofficial account API changes | Suggestions and manifest sync stop working | Manual Watched list and reinstall prompt as fallbacks; surface errors on the dashboard |
| Some titles lack an IMDb ID on TMDB | Title can't appear in Stremio | Flag in the web UI; allow manual IMDb ID entry |
| TMDB watch provider data lags real availability | Trending filter shows a title that just left a service | Accept; data comes from JustWatch via TMDB and refreshes daily |
| Addon URL leaks | Others can see list contents | Random token in the URL path; regenerate from settings |

Decisions made:

- Suggestions can include any certification; a setting caps them when wanted.
- Seasonal lists archive automatically after their end date, and the dates stay editable.
- The stack is Node and TypeScript (see Architecture and deployment).

## Future backlog

- Separate Stremio accounts per person. Today the household shares one account. If that changes, the addon needs watch history sync per account, a choice between merged and per-person suggestions, and an install token per account so each person can see different rows.
