import fs from 'node:fs';
import path from 'node:path';
import { backupDir, today } from './config.js';
import { db, getSetting, setSetting } from './db.js';
import { purgeExpiredSessions } from './auth.js';
import { refreshArchived } from './lists.js';
import { purgeExpiredCache } from './tmdb.js';

const BACKUP_KEEP_DAYS = 14;
const BACKUP_HOUR = 3;

export async function backupNow() {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `lists-${today()}.db`);
  await db().backup(file);
  setSetting('last_backup', today());

  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 24 * 3600_000;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (/^lists-\d{4}-\d{2}-\d{2}\.db$/.test(f) && fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full);
  }
  return file;
}

async function tick(log: (msg: string, err?: unknown) => void) {
  try {
    refreshArchived();
    purgeExpiredCache();
    purgeExpiredSessions();
    if (new Date().getHours() >= BACKUP_HOUR && getSetting('last_backup') !== today()) {
      log(`Backup written to ${await backupNow()}`);
    }
  } catch (err) {
    log('Scheduled task failed', err);
  }
}

export function startScheduler(log: (msg: string, err?: unknown) => void) {
  void tick(log);
  const timer = setInterval(() => void tick(log), 15 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
