import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { titleKey, type Title } from './api';

interface Selection {
  items: Title[];
  has: (t: Title) => boolean;
  toggle: (t: Title) => void;
  addMany: (ts: Title[]) => void;
  clear: () => void;
}

const SelectionContext = createContext<Selection | null>(null);
const STORAGE_KEY = 'selection';

function load(): Map<string, Title> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return new Map((JSON.parse(raw) as Title[]).map((t) => [titleKey(t), t]));
  } catch {
    // Storage can be unavailable (private mode); start empty.
  }
  return new Map();
}

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<Map<string, Title>>(load);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...map.values()]));
    } catch {
      // ignore
    }
  }, [map]);

  const toggle = useCallback((t: Title) => {
    setMap((m) => {
      const next = new Map(m);
      const k = titleKey(t);
      if (next.has(k)) next.delete(k);
      else next.set(k, t);
      return next;
    });
  }, []);

  const addMany = useCallback((ts: Title[]) => {
    setMap((m) => {
      const next = new Map(m);
      for (const t of ts) next.set(titleKey(t), t);
      return next;
    });
  }, []);

  const clear = useCallback(() => setMap(new Map()), []);

  const value = useMemo<Selection>(
    () => ({ items: [...map.values()], has: (t) => map.has(titleKey(t)), toggle, addMany, clear }),
    [map, toggle, addMany, clear],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection() {
  const s = useContext(SelectionContext);
  if (!s) throw new Error('SelectionProvider missing');
  return s;
}

// ---------- Toasts ----------

const ToastContext = createContext<(msg: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msgs, setMsgs] = useState<{ id: number; text: string }[]>([]);
  const show = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setMsgs((m) => [...m, { id, text }]);
    setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {msgs.map((m) => (
          <div key={m.id} className="toast" onClick={() => setMsgs((all) => all.filter((x) => x.id !== m.id))}>
            {m.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
