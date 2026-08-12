/* ─────────────────────────────────────────────────────────────────────────────
 * ThemeToggle — dark/light for the landing page.
 *
 * The whole page is written against the --ink* tokens, so switching themes is a
 * re-point of that palette in tokens.css, not a second stylesheet. This just
 * stamps `data-theme` on <html> and remembers the choice.
 *
 * THREE THINGS IT GETS RIGHT, each of which is the usual bug:
 *  • DARK IS THE DEFAULT, and it does not drift. The cover page is designed
 *    dark — the hero video, the glow behind it and the depth ramp in the
 *    screenshots are all keyed to a dark ground — so a visitor who has never
 *    touched the toggle gets dark whatever their OS says. Following
 *    `prefers-color-scheme` instead meant the same link showed a different
 *    product depending on the machine, and a laptop set to flip at sunrise
 *    would silently change the page under a user who never asked. An explicit
 *    choice is still honoured and still sticks — that is what the toggle is for.
 *  • It is applied before paint. `useLayoutEffect` and the inline bootstrap in
 *    index.html mean the chosen theme is on <html> before the first pixel, so
 *    there is no flash of the other one.
 *  • The console is deliberately untouched — it is a light instrument panel and
 *    dark chrome fights the basemap.
 * ─────────────────────────────────────────────────────────────────────────── */
import React, { useCallback, useLayoutEffect, useState } from 'react';

const KEY = 'ft-theme';
export const DEFAULT_THEME = 'dark';

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
  const [theme, setTheme] = useState(() => storedTheme() || DEFAULT_THEME);

  useLayoutEffect(() => { applyTheme(theme); }, [theme]);

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
