import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../state';

interface SettingsData {
  manifestUrl: string;
  stremioUrl: string;
  addonToken: string;
  region: string;
  tmdbKeyFromEnv: boolean;
  lastBackup: string | null;
}

export function Settings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [tmdbKey, setTmdbKey] = useState('');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const toast = useToast();

  useEffect(() => {
    api<SettingsData>('/api/settings').then(setS).catch((e) => toast(e.message));
  }, [toast]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(s!.manifestUrl);
      toast('Copied');
    } catch {
      toast('Copy failed; select the URL and copy it by hand');
    }
  }

  async function regenerate() {
    if (!confirm('Make a new addon URL? Every device with the old one installed stops getting rows until you reinstall.')) return;
    const r = await api<Partial<SettingsData>>('/api/settings/regenerate-token', { method: 'POST', body: {} });
    setS((x) => x && { ...x, ...r });
    toast('New addon URL created. Reinstall it in Stremio.');
  }

  async function save(body: Record<string, string>, done: () => void) {
    try {
      await api('/api/settings', { body });
      done();
      toast('Saved');
    } catch (e: any) {
      toast(e.message);
    }
  }

  async function logout() {
    await api('/api/logout', { method: 'POST', body: {} });
    window.location.reload();
  }

  if (!s) return <div className="spinner page" />;

  return (
    <div className="page narrow">
      <h1>Settings</h1>

      <section className="card">
        <h2>Install in Stremio</h2>
        <p className="muted small">
          On a TV, open Stremio's addon search and paste the URL, or open this page on a phone signed in to the same Stremio account and
          tap Install.
        </p>
        <div className="row-gap">
          <a className="btn primary" href={s.stremioUrl}>
            Install in Stremio
          </a>
          <button type="button" className="btn" onClick={copy}>
            Copy URL
          </button>
        </div>
        <input className="url" readOnly value={s.manifestUrl} onFocus={(e) => e.target.select()} />
        <p className="muted small">
          New lists and renamed lists show up after Stremio refreshes the addon, which can mean reinstalling it until Sync to Stremio arrives
          in phase 2. Edits to existing lists show up within about five minutes.
        </p>
        <button type="button" className="btn danger" onClick={regenerate}>
          Regenerate URL
        </button>
      </section>

      <section className="card">
        <h2>TMDB API key</h2>
        {s.tmdbKeyFromEnv && <p className="muted small">Currently using TMDB_API_KEY from the container environment.</p>}
        <div className="inline-form">
          <input value={tmdbKey} onChange={(e) => setTmdbKey(e.target.value)} placeholder="New API key or read access token" />
          <button type="button" className="btn" disabled={!tmdbKey.trim()} onClick={() => save({ tmdbApiKey: tmdbKey }, () => setTmdbKey(''))}>
            Save
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Admin password</h2>
        <label className="field">
          <span>Current password</span>
          <input type="password" autoComplete="current-password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
        </label>
        <label className="field">
          <span>New password (8+ characters)</span>
          <input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn"
          disabled={!currentPw || newPw.length < 8}
          onClick={() =>
            save({ currentPassword: currentPw, newPassword: newPw }, () => {
              setCurrentPw('');
              setNewPw('');
            })
          }
        >
          Change password
        </button>
      </section>

      <section className="card">
        <h2>Backups</h2>
        <p className="muted small">
          Nightly copy of the database to /data/backups, kept 14 days. Last backup: {s.lastBackup ?? 'not yet'}.
        </p>
      </section>

      <button type="button" className="btn ghost" onClick={logout}>
        Log out
      </button>
    </div>
  );
}
