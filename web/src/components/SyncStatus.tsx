import { useCallback, useEffect, useState } from 'react';
import { api, timeAgo, type StremioStatus } from '../api';
import { useToast } from '../state';

/** One-line Stremio sync state with a Sync button. `refreshKey` re-reads status after list changes. */
export function SyncStatus({ refreshKey = 0 }: { refreshKey?: number }) {
  const [s, setS] = useState<StremioStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    api<StremioStatus>('/api/stremio').then(setS).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // Auto-sync runs a few seconds after a change; check again once it has had time to finish.
    const t = setTimeout(load, 8000);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  async function sync() {
    setBusy(true);
    try {
      const r = await api<StremioStatus & { added: boolean }>('/api/stremio/sync', { method: 'POST', body: {} });
      setS(r);
      toast(r.added ? 'Added the addon to your Stremio account' : 'Synced. Stremio picks up new rows next time it refreshes.');
    } catch (e: any) {
      toast(`Sync failed: ${e.message}. Reinstalling the addon also works.`);
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!s) return null;
  if (!s.connected) {
    return (
      <p className="sync-note muted small">
        New or renamed lists need the addon reinstalled in Stremio. <a href="#/settings">Connect your Stremio account</a> to push
        them automatically.
      </p>
    );
  }
  return (
    <div className={`sync-status small${s.lastError ? ' error' : ''}`}>
      <span>
        {s.lastError
          ? `Stremio sync failed: ${s.lastError}`
          : s.outOfSync
            ? 'Rows changed; syncing to Stremio…'
            : `Stremio rows up to date · synced ${timeAgo(s.lastSync)}`}
      </span>
      <button type="button" className="btn ghost" onClick={sync} disabled={busy}>
        {busy ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  );
}
