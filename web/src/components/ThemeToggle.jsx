/* ─────────────────────────────────────────────────────────────────────────────
 * ThemeToggle — dark/light for the landing page.
 *
 * The whole page is written against the --ink* tokens, so switching themes is a
 * re-point of that palette in tokens.css, not a second stylesheet. This just
 * stamps `data-theme` on <html> and remembers the choice.
 *
 * THREE THINGS IT GETS RIGHT, each of which is the usual bug:
 *  • It follows the OS until the user actually chooses. An explicit choice is
 *    stored; an unset one keeps tracking `prefers-color-scheme` live, so a
 *    machine that flips to dark at sunset takes the page with it.
 *  • It is applied before paint. `useLayoutEffect` and the inline bootstrap in
 *    index.html mean a light-mode visitor never sees a dark flash first.
 *  • The console is deliberately untouched — it is a light instrument panel and
 *    dark chrome fights the basemap.
 * ─────────────────────────────────────────────────────────────────────────── */
import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';

const KEY = 'ft-theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function storedTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }          // private mode / storage disabled
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Lets form controls, scrollbars and the browser's own UI match.
  document.documentElement.style.colorScheme = theme;
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(
    () => storedTheme() || (media().matches ? 'dark' : 'light'),
  );

  useLayoutEffect(() => { applyTheme(theme); }, [theme]);

  // Track the OS only while the user has expressed no preference of their own.
  useEffect(() => {
    if (storedTheme()) return;
    const m = media();
    const onChange = (e) => setTheme(e.matches ? 'dark' : 'light');
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch { /* storage disabled */ }
      return next;
    });
  }, []);

  const nextLabel = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="lp-theme"
      onClick={toggle}
      title={`Switch to ${nextLabel} mode`}
      aria-label={`Switch to ${nextLabel} mode`}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
