import path from 'node:path';

export const config = {
  port: Number(process.env.PORT ?? 7000),
  dataDir: process.env.DATA_DIR ?? '/data',
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  envTmdbApiKey: process.env.TMDB_API_KEY ?? '',
  envAdminPassword: process.env.ADMIN_PASSWORD ?? '',
  tmdbBaseUrl: process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3',
};

export const dbPath = () => path.join(config.dataDir, 'lists.db');
export const backupDir = () => path.join(config.dataDir, 'backups');

/** Today's date as YYYY-MM-DD in the container's local time zone (TZ env). */
export function today(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
