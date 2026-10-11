import { useEffect, useState } from 'react';
import { api, timeAgo, type StremioStatus } from '../api';
import { useToast } from '../state';

interface SettingsData {
  manifestUrl: string;
  stremioUrl: string;
  addonToken: string;
  region: string;
  tmdbKeyFromEnv: boolean;
  lastBackup: string | null;
  enabledServices: string[];
  allServices: string[];
  trendingRefreshedAt: number | null;
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
          Edits to existing rows show up within about five minutes. New, renamed or reordered rows need the Stremio account connected below,
          or a reinstall.
        </p>
        <button type="button" className="btn danger" onClick={regenerate}>
          Regenerate URL
        </button>
      </section>

      <StremioAccount />

      <section className="card">
        <h2>Trending services</h2>
        <p className="muted small">
          Services in the Trending row's filter. “All” combines the checked ones. Last refreshed {timeAgo(s.trendingRefreshedAt)}.
        </p>
        <div className="chips">
          {s.allServices.map((name) => {
            const on = s.enabledServices.includes(name);
            return (
              <button
                key={name}
                type="button"
                className="chip"
                aria-pressed={on}
                onClick={async () => {
                  const next = on ? s.enabledServices.filter((x) => x !== name) : [...s.enabledServices, name];
                  try {
                    const r = await api<{ enabledServices: string[] }>('/api/settings/rows', { body: { enabledServices: next } });
                    setS((x) => x && { ...x, enabledServices: r.enabledServices });
                    toast('Saved. Trending rebuilds in the background over the next minute or two.');
                  } catch (e: any) {
                    toast(e.message);
                  }
                }}
              >
                {name}
              </button>
            );
          })}
        </div>
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

function StremioAccount() {
  const [st, setSt] = useState<StremioStatus | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [useKey, setUseKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api<StremioStatus>('/api/stremio').then(setSt).catch(() => {});
  }, []);

  async function run(path: string, body: Record<string, string> = {}, done?: string) {
    setBusy(true);
    try {
      const r = await api<StremioStatus>(path, { body });
      setSt(r);
      setPassword('');
      setAuthKey('');
      if (r.lastError) toast(`Stremio: ${r.lastError}`);
      else if (done) toast(done);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!st) return null;

  return (
    <section className="card">
      <h2>Stremio account</h2>
      {st.connected ? (
        <>
          <p className="small">
            Connected{st.email ? ` as ${st.email}` : ''}. Row changes are pushed to Stremio automatically · last sync {timeAgo(st.lastSync)}.
          </p>
          {st.lastError && <p className="error small">Last sync failed: {st.lastError}</p>}
          <div className="row-gap">
            <button type="button" className="btn" disabled={busy} onClick={() => run('/api/stremio/sync', {}, 'Synced to Stremio')}>
              Sync now
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => run('/api/stremio/disconnect')}>
              Disconnect
            </button>
          </div>
          <p className="muted small">Each device picks up new rows the next time Stremio refreshes its addons, usually on restart.</p>
        </>
      ) : (
        <>
          <p className="muted small">
            Lets this app update the installed addon on your account when lists are added, renamed, reordered or come into season, so
            nobody has to reinstall. Your password is sent to Stremio once to get a session key and is not stored.
          </p>
          {useKey ? (
            <label className="field">
              <span>Auth key (from web.stremio.com: browser console, localStorage profile → auth.key)</span>
              <input value={authKey} onChange={(e) => setAuthKey(e.target.value)} autoComplete="off" />
            </label>
          ) : (
            <>
              <label className="field">
                <span>Stremio email</span>
                <input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label className="field">
                <span>Stremio password</span>
                <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            </>
          )}
          <div className="row-gap">
            <button
              type="button"
              className="btn primary"
              disabled={busy || (useKey ? !authKey.trim() : !email.trim() || !password)}
              onClick={() =>
                run('/api/stremio/connect', useKey ? { authKey } : { email, password }, 'Connected and synced to Stremio')
              }
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setUseKey((x) => !x)}>
              {useKey ? 'Use email and password' : 'Signed in with Google or Facebook? Use an auth key'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
