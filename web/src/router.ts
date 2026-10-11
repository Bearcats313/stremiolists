import { useEffect, useState } from 'react';

export function useHashRoute(): string[] {
  const read = () => (window.location.hash.replace(/^#\/?/, '') || 'browse').split('/');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (path: string) => {
  window.location.hash = `#/${path}`;
};
