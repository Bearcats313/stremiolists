import { useEffect, useState } from 'react';
import { api, posterUrl, type Title } from '../api';
import { useSelection, useToast } from '../state';

interface Details {
  tmdbId: number;
  mediaType: Title['mediaType'];
  imdbId: string | null;
  imdbIdManual: boolean;
  name: string;
  year: number | null;
  posterPath: string | null;
  overview: string;
  certification: string | null;
  rating: number | null;
  genres: string[];
  runtime: number | null;
  providers: { name: string; logoPath: string | null }[];
  inLists: string[];
}

interface Props {
  title: Title;
  onClose: () => void;
  onMoreLikeThis?: (t: Title) => void;
  /** Hide the select button where the global selection isn't in use (paste import). */
  selectable?: boolean;
}

export function DetailDrawer({ title, onClose, onMoreLikeThis, selectable = true }: Props) {
  const [d, setD] = useState<Details | null>(null);
  const [error, setError] = useState('');
  const [imdbDraft, setImdbDraft] = useState('');
  const sel = useSelection();
  const toast = useToast();

  useEffect(() => {
    setD(null);
    setError('');
    api<Details>(`/api/title/${title.mediaType}/${title.tmdbId}`)
      .then((r) => {
        setD(r);
        setImdbDraft(r.imdbId ?? '');
      })
      .catch((e) => setError(e.message));
  }, [title.mediaType, title.tmdbId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function saveImdb() {
    try {
      const r = await api<{ imdbId: string | null }>(`/api/title/${title.mediaType}/${title.tmdbId}/imdb`, {
        method: 'PUT',
        body: { imdbId: imdbDraft.trim() || null },
      });
      setD((x) => x && { ...x, imdbId: r.imdbId, imdbIdManual: !!imdbDraft.trim() });
      toast('IMDb ID saved');
    } catch (e: any) {
      toast(e.message);
    }
  }

  const selected = sel.has(title);
  const src = posterUrl(d?.posterPath ?? title.posterPath, 'w342');

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title.name} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="drawer-head">
          {src && <img src={src} alt="" />}
          <div>
            <h2>{d?.name ?? title.name}</h2>
            <p className="muted">
              {[
                d?.year ?? title.year,
                d?.certification,
                d?.runtime ? `${d.runtime} min` : null,
                d?.rating ? `★ ${d.rating.toFixed(1)}` : null,
                title.mediaType === 'series' ? 'Series' : 'Movie',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {d?.genres.length ? <p className="small muted">{d.genres.join(', ')}</p> : null}
          </div>
        </div>

        {error && <p className="error">{error}</p>}
        {!d && !error && <div className="spinner" />}

        {d && (
          <>
            <p>{d.overview || 'No overview.'}</p>
            <h3>Streams on</h3>
            {d.providers.length ? (
              <div className="providers">
                {d.providers.map((p) => (
                  <span key={p.name} className="provider" title={p.name}>
                    {p.logoPath && <img src={posterUrl(p.logoPath, 'w45')!} alt="" />}
                    {p.name}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted small">Not on a subscription service in the US.</p>
            )}
            {d.inLists.length > 0 && (
              <>
                <h3>In your lists</h3>
                <p>{d.inLists.join(', ')}</p>
              </>
            )}
            <h3>IMDb ID</h3>
            {!d.imdbId && <p className="warn small">TMDB has no IMDb ID for this title, so it can't appear in Stremio until you add one.</p>}
            <div className="inline-form">
              <input value={imdbDraft} onChange={(e) => setImdbDraft(e.target.value)} placeholder="tt0000000" />
              <button type="button" className="btn" onClick={saveImdb} disabled={imdbDraft === (d.imdbId ?? '')}>
                Save
              </button>
            </div>
            {d.imdbIdManual && <p className="muted small">Set by hand. Clear it and save to go back to TMDB's value.</p>}
          </>
        )}

        <div className="drawer-actions">
          {selectable && (
            <button type="button" className={`btn ${selected ? '' : 'primary'}`} onClick={() => sel.toggle(title)}>
              {selected ? 'Deselect' : 'Select'}
            </button>
          )}
          {onMoreLikeThis && (
            <button type="button" className="btn" onClick={() => onMoreLikeThis(title)}>
              More like this
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
