import crypto from 'node:crypto';
import { buildManifest } from './addon.js';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';

// Unofficial Stremio account API (the one the Stremio apps use). It can change without notice.
const API = (process.env.STREMIO_API_URL ?? 'https://api.strem.io/api').replace(/\/+$/, '');

export class StremioError extends Error {}

export async function call<T = any>(method: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new StremioError(`Couldn't reach Stremio: ${err.message}`);
  }
  const data = (await res.json().catch(() => null)) as any;
  if (!res.ok || !data || data.error) {
    throw new StremioError(data?.error?.message ?? `Stremio returned ${res.status}`);
  }
  return data.result as T;
}

export async function stremioLogin(email: string, password: string) {
  const r = await call<{ authKey: string; user?: { email?: string } }>('login', {
    type: 'Login',
    email,
    password,
    facebook: false,
  });
  if (!r?.authKey) throw new StremioError('Stremio did not return an auth key');
  connectWithKey(r.authKey, r.user?.email ?? email);
}

export async function verifyAuthKey(authKey: string) {
  // Any authenticated call works as a check; this one is cheap and needed later anyway.
  await call('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
}

export function connectWithKey(authKey: string, email: string | null) {
  setSetting('stremio_auth_key', authKey);
  setSetting('stremio_email', email);
  setSetting('stremio_sync_error', null);
  setSetting('stremio_synced_hash', null);
}

export function disconnectStremio() {
  for (const k of ['stremio_auth_key', 'stremio_email', 'stremio_sync_error', 'stremio_synced_hash', 'stremio_synced_at']) {
    setSetting(k, null);
  }
}

/** Fingerprint of everything Stremio caches from the manifest: the rows, their names and filters. */
export function manifestHash() {
  const m = buildManifest();
  return crypto.createHash('sha1').update(JSON.stringify({ name: m.name, catalogs: m.catalogs })).digest('hex');
}

export function stremioStatus() {
  const connected = !!getSetting('stremio_auth_key');
  const synced = getSetting('stremio_synced_hash');
  return {
    connected,
    email: getSetting('stremio_email'),
    lastSync: getSetting('stremio_synced_at') ? Number(getSetting('stremio_synced_at')) : null,
    lastError: getSetting('stremio_sync_error'),
    outOfSync: synced !== manifestHash(),
  };
}

function manifestUrl(fallback: string | undefined) {
  const base = config.publicUrl;
  if (base) return `${base}/${getSetting('addon_token')}/manifest.json`;
  if (fallback) return fallback;
  throw new StremioError('Set PUBLIC_URL (or LISTS_HOST in the stack) so the addon URL is known');
}

/** Push the current manifest into the account's installed addons so new rows appear without reinstalling. */
export async function syncToStremio() {
  const authKey = getSetting('stremio_auth_key');
  if (!authKey) throw new StremioError('Connect a Stremio account first');
  const hash = manifestHash();
  try {
    const { addons } = await call<{ addons: any[] }>('addonCollectionGet', {
      type: 'AddonCollectionGet',
      authKey,
      update: true,
    });
    if (!Array.isArray(addons)) throw new StremioError('Unexpected response from Stremio');
    const manifest = buildManifest();
    const idx = addons.findIndex((a) => a?.manifest?.id === manifest.id);
    const url = manifestUrl(idx >= 0 ? addons[idx].transportUrl : undefined);
    if (idx >= 0) addons[idx] = { ...addons[idx], transportUrl: url, manifest };
    else addons.push({ transportUrl: url, transportName: 'http', manifest, flags: {} });
    await call('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons });
    setSetting('stremio_synced_hash', hash);
    setSetting('stremio_synced_at', String(Date.now()));
    setSetting('stremio_sync_error', null);
    return { added: idx < 0 };
  } catch (err: any) {
    setSetting('stremio_sync_error', err.message);
    throw err instanceof StremioError ? err : new StremioError(err.message);
  }
}

let timer: NodeJS.Timeout | null = null;

/** Sync shortly after changes that alter the rows, if an account is connected and something changed. */
export function scheduleAutoSync(log: (msg: string, err?: unknown) => void, delayMs = 5000) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void autoSync(log);
  }, delayMs);
  timer.unref();
}

export async function autoSync(log: (msg: string, err?: unknown) => void) {
  if (!getSetting('stremio_auth_key')) return;
  if (getSetting('stremio_synced_hash') === manifestHash()) return;
  try {
    await syncToStremio();
    log('Synced addon rows to Stremio');
  } catch (err) {
    log('Stremio sync failed', err);
  }
}
