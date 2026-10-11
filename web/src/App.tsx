import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { SelectionTray } from './components/SelectionTray';
import { Browse } from './pages/Browse';
import { Import } from './pages/Import';
import { ListDetail } from './pages/ListDetail';
import { Lists } from './pages/Lists';
import { Settings } from './pages/Settings';
import { useHashRoute } from './router';
import { SelectionProvider, ToastProvider } from './state';

interface Status {
  setupNeeded: boolean;
  needsPassword: boolean;
  needsTmdbKey: boolean;
  loggedIn: boolean;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    api<Status>('/api/status')
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener('unauthorized', refresh);
    return () => window.removeEventListener('unauthorized', refresh);
  }, [refresh]);

  let body;
  if (error) body = <p className="error page">{error}</p>;
  else if (!status) body = <div className="spinner page" />;
  else if (status.setupNeeded) body = <Setup status={status} onDone={refresh} />;
  else if (!status.loggedIn) body = <Login onDone={refresh} />;
  else body = <Shell />;

  return (
    <ToastProvider>
      <SelectionProvider>
        {body}
        <footer className="footer">
          <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">TMDB</a>
          <span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
        </footer>
      </SelectionProvider>
    </ToastProvider>
  );
}

function Shell() {
  const route = useHashRoute();
  const [section, param] = route;

  let page;
  if (section === 'import') page = <Import />;
  else if (section === 'lists' && param) page = <ListDetail key={param} id={Number(param)} />;
  else if (section === 'lists') page = <Lists />;
  else if (section === 'settings') page = <Settings />;
  else page = <Browse />;

  const tab = (name: string, label: string) => (
    <a href={`#/${name}`} aria-current={section === name || (name === 'browse' && !['import', 'lists', 'settings'].includes(section)) ? 'page' : undefined}>
      {label}
    </a>
  );

  return (
    <>
      <nav className="nav">
        <span className="brand">Lists</span>
        {tab('browse', 'Browse')}
        {tab('import', 'Paste')}
        {tab('lists', 'My lists')}
        {tab('settings', 'Settings')}
      </nav>
      <main>{page}</main>
      {/* The browse selection follows you between pages, except where a page has its own tray. */}
      {section !== 'import' && !(section === 'lists' && param) && <SelectionTray />}
    </>
  );
}

function Setup({ status, onDone }: { status: Status; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (status.needsPassword && password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    setError('');
    try {
      await api('/api/setup', { body: { password, tmdbApiKey: key } });
      onDone();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="page narrow auth" onSubmit={submit}>
      <h1>Set up Personal Lists</h1>
      {status.needsPassword ? (
        <>
          <label className="field">
            <span>Admin password (8+ characters)</span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="field">
            <span>Confirm password</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        </>
      ) : (
        <label className="field">
          <span>Admin password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      )}
      {status.needsTmdbKey && (
        <label className="field">
          <span>
            TMDB API key (free from{' '}
            <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">
              themoviedb.org/settings/api
            </a>
            )
          </span>
          <input value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? 'Checking…' : 'Save'}
      </button>
    </form>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/api/login', { body: { password } });
      onDone();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <form className="page narrow auth" onSubmit={submit}>
      <h1>Personal Lists</h1>
      <label className="field">
        <span>Password</span>
        <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" className="btn primary">
        Log in
      </button>
    </form>
  );
}
