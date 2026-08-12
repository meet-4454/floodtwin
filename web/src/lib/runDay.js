/* ─────────────────────────────────────────────────────────────────────────────
 * runDay — which DAY a forecast run covers, in the words an operator checks it
 * against: "today", "yesterday", else the date.
 *
 * Its own module, with no imports, because BOTH surfaces need it and they must
 * not need each other: the landing page pulls nothing from the engine (that is
 * what keeps three.js and the Mappls SDK off the cover page's critical path),
 * and panels.jsx imports the engine's palette and simData. Reaching across for
 * one formatter would have dragged those into the landing chunk.
 *
 * WHY IT EXISTS AT ALL. Run freshness used to be signalled by the colour of a
 * 6 px dot beside a correctly-formatted date. The date was always real, so a
 * feed that had quietly stopped refreshing looked exactly like a healthy one —
 * which is how a forecast sat a full day stale without anyone noticing. Naming
 * the day makes that obvious at a glance.
 * ─────────────────────────────────────────────────────────────────────────── */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function runDay(iso) {
  const t = new Date(iso);
  if (Number.isNaN(+t)) return null;
  // Compared as calendar days in the viewer's own timezone, not as a 24 h
  // difference: a 05:00 run is "today" from 05:00 right through to midnight,
  // which is how the people reading it talk about it.
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(t) - midnight(new Date())) / 86400000);
  if (days === 0) return 'today';
  if (days === -1) return 'yesterday';
  if (days === 1) return 'tomorrow';
  return `${String(t.getDate()).padStart(2, '0')}-${MONTHS[t.getMonth()]}`;
}
