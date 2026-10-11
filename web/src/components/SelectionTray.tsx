import { useState } from 'react';
import { posterUrl, titleKey } from '../api';
import { useSelection } from '../state';
import { AddDialog } from './AddDialog';

export function SelectionTray() {
  const sel = useSelection();
  const [adding, setAdding] = useState(false);
  if (!sel.items.length) return null;

  return (
    <>
      <div className="tray">
        <div className="tray-count">{sel.items.length} selected</div>
        <div className="tray-thumbs">
          {sel.items
            .slice(-12)
            .reverse()
            .map((t) => {
              const src = posterUrl(t.posterPath, 'w92');
              return (
                <button key={titleKey(t)} type="button" className="thumb" onClick={() => sel.toggle(t)} title={`Remove ${t.name}`}>
                  {src ? <img src={src} alt={t.name} /> : <span>{t.name.slice(0, 2)}</span>}
                </button>
              );
            })}
        </div>
        <button type="button" className="btn ghost" onClick={sel.clear}>
          Clear
        </button>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>
          Add
        </button>
      </div>
      {adding && (
        <AddDialog
          items={sel.items}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            sel.clear();
            window.dispatchEvent(new Event('lists-changed'));
          }}
        />
      )}
    </>
  );
}
