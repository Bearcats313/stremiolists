import { useEffect, useRef, type ReactNode } from 'react';
import { posterUrl, titleKey, type Title } from '../api';

interface CardProps {
  title: Title;
  selected: boolean;
  onToggle: () => void;
  onInfo?: () => void;
  extraBadge?: ReactNode;
}

export function PosterCard({ title, selected, onToggle, onInfo, extraBadge }: CardProps) {
  const src = posterUrl(title.posterPath);
  return (
    <div className={`poster${selected ? ' selected' : ''}`}>
      <button
        type="button"
        className="poster-hit"
        onClick={onToggle}
        aria-pressed={selected}
        aria-label={`${selected ? 'Deselect' : 'Select'} ${title.name}`}
      >
        <div className="poster-img">
          {src ? <img src={src} alt="" loading="lazy" /> : <div className="poster-fallback">{title.name}</div>}
          <span className="check" aria-hidden>
            ✓
          </span>
          {title.inLists && title.inLists.length > 0 && (
            <span className="badge" title={title.inLists.join(', ')}>
              {title.inLists.length === 1 ? title.inLists[0] : `${title.inLists.length} lists`}
            </span>
          )}
          {extraBadge}
        </div>
      </button>
      <div className="poster-meta">
        <div className="poster-title" title={title.name}>
          {title.name}
        </div>
        <div className="poster-sub">
          <span>
            {title.year ?? '—'}
            {title.rating ? ` · ★ ${title.rating.toFixed(1)}` : ''}
          </span>
          {onInfo && (
            <button type="button" className="info-btn" onClick={onInfo} aria-label={`Details for ${title.name}`}>
              i
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface GridProps {
  titles: Title[];
  isSelected: (t: Title) => boolean;
  onToggle: (t: Title) => void;
  onInfo?: (t: Title) => void;
  onLoadMore?: () => void;
  loading?: boolean;
}

export function PosterGrid({ titles, isSelected, onToggle, onInfo, onLoadMore, loading }: GridProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef(onLoadMore);
  loadMore.current = onLoadMore;

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore.current?.(), {
      rootMargin: '600px',
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <>
      <div className="grid">
        {titles.map((t) => (
          <PosterCard
            key={titleKey(t)}
            title={t}
            selected={isSelected(t)}
            onToggle={() => onToggle(t)}
            onInfo={onInfo && (() => onInfo(t))}
          />
        ))}
      </div>
      <div ref={sentinel} className="sentinel">
        {loading && <div className="spinner" aria-label="Loading" />}
      </div>
    </>
  );
}
