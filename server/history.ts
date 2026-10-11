import { db, getSetting, setSetting, type MediaType } from './db.js';
import { call, StremioError } from './stremio.js';

export interface LibraryItem {
  _id: string;
  type: string;
  name?: string;
  removed?: boolean;
  temp?: boolean;
  _mtime?: string;
  state?: {
    lastWatched?: string;
    timeWatched?: number;
    timesWatched?: number;
    flaggedWatched?: number;
    duration?: number;
  };
}

/**
 * Stremio counts a movie as watched once most of it has played, and marks series progress per episode.
 * Treat a library item as watched if Stremio flagged it, counted a full watch, or (for series) any
 * episode has been played. Removing an item from the library doesn't undo having watched it.
 */
export function isWatched(item: LibraryItem): boolean {
  const s = item.state ?? {};
  if ((s.timesWatched ?? 0) > 0 || (s.flaggedWatched ?? 0) > 0) return true;
  if (item.type === 'series') return (s.timeWatched ?? 0) > 0;
  return !!s.duration && (s.timeWatched ?? 0) >= 0.7 * s.duration;
}

export async function syncWatchHistory(): Promise<number> {
  const authKey = getSetting('stremio_auth_key');
  if (!authKey) throw new StremioError('Connect a Stremio account first');
  try {
    const items = await call<LibraryItem[]>('datastoreGet', {
      authKey,
      collection: 'libraryItem',
      ids: [],
      all: true,
    });
    if (!Array.isArray(items)) throw new StremioError('Unexpected library response from Stremio');
    const watched = items.filter(
      (i) => typeof i?._id === 'string' && /^tt\d+$/.test(i._id) && (i.type === 'movie' || i.type === 'series') && isWatched(i),
    );
    const d = db();
    const insert = d.prepare(
      `INSERT OR REPLACE INTO watch_history (imdb_id, media_type, last_watched_at, source) VALUES (?, ?, ?, 'stremio')`,
    );
    d.transaction(() => {
      d.prepare(`DELETE FROM watch_history WHERE source = 'stremio'`).run();
      for (const i of watched) {
        const at = Date.parse(i.state?.lastWatched ?? '') || Date.parse(i._mtime ?? '') || null;
        insert.run(i._id, i.type as MediaType, at);
      }
    })();
    setSetting('history_synced_at', String(Date.now()));
    setSetting('history_count', String(watched.length));
    setSetting('history_sync_error', null);
    return watched.length;
  } catch (err: any) {
    setSetting('history_sync_error', err.message);
    throw err instanceof StremioError ? err : new StremioError(err.message);
  }
}

export function historyStatus() {
  return {
    syncedAt: Number(getSetting('history_synced_at')) || null,
    count: Number(getSetting('history_count')) || 0,
    error: getSetting('history_sync_error'),
  };
}
