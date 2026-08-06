/* ─────────────────────────────────────────────────────────────────────────────
 * panels.jsx — the console's read-outs and controls.
 *
 * Each is a small, self-contained component reading the store. They are grouped
 * in one file because they share the same panel chrome and none is big enough to
 * justify its own module; anything that grows past ~120 lines (LayersPanel,
 * MapCanvas) lives on its own.
 * ─────────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useRef, useState } from 'react';
import { useTwin, DEPTH_BAND_STOPS } from '../store/useTwin.js';
import { cssGradient, colorForDepth } from '../engine/palette.js';
import { DATASETS } from '../engine/simData.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const z2 = (n) => String(n).padStart(2, '0');

function fmtDur(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${z2(m % 60)}m`;
}

/* ── Data source ──────────────────────────────────────────────────────────── */
export function DataSourcePanel() {
  const dataset = useTwin((s) => s.dataset);
  const runStatus = useTwin((s) => s.runStatus);
  const setRunStatus = useTwin((s) => s.setRunStatus);

  useEffect(() => {
    let alive = true;
    const poll = () => fetch('/api/live-forecast/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setRunStatus(d); })
      .catch(() => {});
    poll();
    const iv = setInterval(poll, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [setRunStatus]);

  const pick = (id) => useTwin.setState({ dataset: id });
  const built = runStatus?.built;

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-header-left"><span className="panel-icon">🛰️</span><span className="panel-title">Data Source</span></div>
        <span className="panel-badge">{DATASETS[dataset]?.label}</span>
      </div>
      <div className="seg">
        {Object.values(DATASETS).map((d) => (
          <button key={d.id} className={dataset === d.id ? 'is-active' : ''} onClick={() => pick(d.id)}>
            {d.label}
          </button>
        ))}
      </div>
      {/* Only the live feed carries a status line — its freshness is the thing
          you have to know. The event dataset is fixed, so its metrics said the
          same thing every time and were dropped. */}
      {dataset === 'live' && (
        <div className="run-status" title={DATASETS[dataset]?.blurb}>
          <span className={`run-dot ${runStatus?.stale ? 'is-stale' : 'is-live'}`} />
          {runStatus?.building ? 'Syncing a new run…'
            : built ? `From ${new Date(built.base_valid_time).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
            : 'Checking run…'}
        </div>
      )}
    </div>
  );
}

/* ── Timeline ─────────────────────────────────────────────────────────────── */
export function TimeControl() {
  // Select fields INDIVIDUALLY. A selector returning a fresh object gives
  // useSyncExternalStore a new snapshot on every read, so React re-renders
  // forever — it surfaced as "Maximum call stack size exceeded" and took the
  // step handler down with it.
  const step = useTwin((s) => s.step);
  const totalSteps = useTwin((s) => s.totalSteps);
  const playing = useTwin((s) => s.playing);
  const speed = useTwin((s) => s.speed);
  const dataset = useTwin((s) => s.dataset);
  const manifest = useTwin((s) => s.manifest);
  const setStep = useTwin((s) => s.setStep);
  const setPlaying = useTwin((s) => s.setPlaying);
  const setSpeed = useTwin((s) => s.setSpeed);
  const timer = useRef(null);

  useEffect(() => {
    clearInterval(timer.current);
    if (!playing) return;
    timer.current = setInterval(() => {
      const s = useTwin.getState();
      s.setStep(s.step >= s.totalSteps ? 0 : s.step + 1);
    }, speed);
    return () => clearInterval(timer.current);
  }, [playing, speed]);

  let label = '—', sub = '';
  if (dataset === 'live' && manifest?.frames?.[step]) {
    const fr = manifest.frames[step];
    const t = new Date(fr.valid_at || fr.valid_time);
    if (!Number.isNaN(+t)) {
      const base = new Date(manifest.base_valid_time || fr.valid_at);
      label = `T+${fmtDur(t - base)}`;
      const d = t - Date.now();
      sub = `${z2(t.getDate())}-${MONTHS[t.getMonth()]} ${z2(t.getHours())}:${z2(t.getMinutes())} · ${Math.abs(d) <= 3e5 ? 'now' : `${fmtDur(d)} ${d < 0 ? 'ago' : 'ahead'}`}`;
    }
  } else {
    // 13 hourly steps from the rain start at 01:00 on 09-Jul-2025.
    const b = new Date('2025-07-09T01:00:00');
    b.setHours(b.getHours() + step);
    label = `${z2(b.getDate())}-${MONTHS[b.getMonth()]}-${b.getFullYear()}`;
    sub = `hour ${step} of ${totalSteps}`;
  }

  const pct = totalSteps ? (step / totalSteps) * 100 : 0;
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-header-left"><span className="panel-icon">🕐</span><span className="panel-title">Time Control</span></div>
      </div>
      <div className="time-box">
        <div className="time-label">{dataset === 'live' ? 'Lead time' : 'Current time'}</div>
        <div className="time-value">{label}</div>
        <div className="time-sub">{sub}</div>
      </div>
      <input
        type="range" className="time-slider" min={0} max={totalSteps} value={step} step={1}
        onChange={(e) => setStep(+e.target.value)}
        style={{ background: `linear-gradient(to right,var(--primary-400) ${pct}%,#e2e8f0 ${pct}%)` }}
      />
      <div className="transport">
        <button onClick={() => setStep(0)} title="Reset to the first frame">↺</button>
        <button onClick={() => setStep(step - 1)} title="Previous frame">⏮</button>
        <button className="is-primary" onClick={() => setPlaying(!playing)} title={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button onClick={() => setStep(step + 1)} title="Next frame">⏭</button>
        <span className="transport-sep" />
        {[[1000, '½'], [500, '1×'], [250, '2×'], [125, '4×']].map(([v, l]) => (
          <button key={v} className={`speed${speed === v ? ' is-active' : ''}`}
                  onClick={() => setSpeed(v)} title={`Playback speed ${l}`}>{l}</button>
        ))}
      </div>
    </div>
  );
}

/* ── Depth legend, doubling as a band filter ──────────────────────────────── */
// Laid out like zoom.earth's precipitation key: one continuous bar with the
// category names sitting UNDER the colours they refer to, rather than four
// separate swatch rows. Same ramp drives the bar and every pixel on the map.
export function DepthLegend() {
  const bands = useTwin((s) => s.bands);
  const maxDepth = useTwin((s) => s.maxDepth);
  const toggleBand = useTwin((s) => s.toggleBand);
  const resetBands = useTwin((s) => s.resetBands);
  const opacity = useTwin((s) => s.opacity);
  const setOpacity = useTwin((s) => s.setOpacity);

  const e = DEPTH_BAND_STOPS.map((f) => f * maxDepth);
  const fmt = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
  const cats = [
    { label: 'Light',    hi: `<${fmt(e[0])}` },
    { label: 'Moderate', hi: `${fmt(e[1])}` },
    { label: 'High',     hi: `${fmt(e[2])}` },
    { label: 'Severe',   hi: `${fmt(maxDepth)}` },
  ];
  const anyOff = bands.some((b) => !b);

  return (
    <div className="legend">
      <div className="legend-head">
        <span>💧</span><span className="legend-title">Flood depth</span>
        {anyOff && <button className="legend-reset" onClick={resetBands}>Reset</button>}
      </div>
      <div className="legend-bar">
        <div className="legend-ramp" style={{ background: cssGradient('90deg') }} />
        <div className="legend-cats">
          {cats.map((c, i) => (
            <button
              key={c.label}
              className={`legend-cat${bands[i] ? '' : ' is-off'}`}
              onClick={() => toggleBand(i)}
              aria-pressed={bands[i]}
              title={`${c.label} — up to ${c.hi} m. Click to hide this range.`}
            >
              <span className="legend-cat-name">{c.label}</span>
              <span className="legend-cat-val">{c.hi}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="legend-op">
        <label htmlFor="opacity">Opacity</label>
        <input
          id="opacity" type="range" min={0} max={100} value={Math.round(opacity * 100)}
          onChange={(ev) => setOpacity(+ev.target.value / 100)}
        />
        <span>{Math.round(opacity * 100)}%</span>
      </div>
      <div className="legend-hint">metres · click a band to hide it</div>
    </div>
  );
}

/* ── KPI strip ────────────────────────────────────────────────────────────── */
export function KpiStrip() {
  const kpi = useTwin((s) => s.kpi);
  const surcharged = useTwin((s) => s.surcharged);
  const drainOn = useTwin((s) => s.features.drainage);
  if (!kpi) return null;
  // A grid cell is ~0.001 km², so early in the event a plain .toFixed(1) reads
  // "0.0 km²" next to a 1.4 m maximum, which looks broken rather than early.
  const area = (v) => (v >= 1 ? `${v.toFixed(1)} km²`
    : v >= 0.01 ? `${v.toFixed(2)} km²`
    : v > 0 ? `${Math.round(v * 1e6).toLocaleString()} m²` : '—');
  const items = [
    { v: area(kpi.wetKm2), k: 'inundated' },
    { v: area(kpi.impassableKm2), k: 'over 0.30 m' },
    { v: `${kpi.maxDepth.toFixed(2)} m`, k: 'deepest' },
  ];
  if (drainOn) items.push({ v: surcharged.toLocaleString(), k: 'nodes surcharging' });
  return (
    <div className="kpi-strip">
      {items.map((i) => (
        <div className="kpi" key={i.k}>
          <span className="kpi-v">{i.v}</span>
          <span className="kpi-k">{i.k}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Hotspots ─────────────────────────────────────────────────────────────── */
export function HotspotsPanel({ twin }) {
  const hotspots = useTwin((s) => s.hotspots);
  const maxDepth = useTwin((s) => s.maxDepth);
  const on = useTwin((s) => s.features.hotspots);
  const [names, setNames] = useState({});

  useEffect(() => {
    if (!hotspots.length) return;
    const key = (s) => `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`;
    const need = hotspots.filter((s) => !names[key(s)]);
    if (!need.length) return;
    let alive = true;
    fetch('/api/locality?pts=' + encodeURIComponent(need.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).join(';')))
      .then((r) => (r.ok ? r.json() : { results: [] }))
      .then(({ results }) => {
        if (!alive) return;
        const next = { ...names };
        for (const r of results || []) if (r?.name) next[`${r.lat.toFixed(3)},${r.lng.toFixed(3)}`] = r.name;
        setNames(next);
      })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotspots]);

  if (!on || !hotspots.length) return null;
  return (
    <div className="hotspots">
      <div className="hs-head"><span>📍</span><span className="hs-title">Flood hotspots</span><span className="hs-badge">{hotspots.length}</span></div>
      <div className="hs-list">
        {hotspots.map((s, i) => (
          <button key={i} className="hs-row" onClick={() => twin?.flyTo(s.lng, s.lat, 16)}>
            <span className="hs-dot" style={{ background: colorForDepth(s.max, maxDepth) }}>{i + 1}</span>
            <span className="hs-main">
              <span className="hs-loc">{names[`${s.lat.toFixed(3)},${s.lng.toFixed(3)}`] || 'Locating…'}</span>
              <span className="hs-sub">avg {s.avg.toFixed(2)} m · peak {s.max.toFixed(2)} m</span>
            </span>
          </button>
        ))}
      </div>
      <div className="hs-hint">Worst pockets in view at this timestep</div>
    </div>
  );
}

/* ── Road passability ─────────────────────────────────────────────────────── */
export function RoadPanel({ twin }) {
  const segs = useTwin((s) => s.roadSegments);
  const on = useTwin((s) => s.features.roads);
  if (!on) return null;
  const blocked = segs.filter((s) => s.status === 'blocked').length;
  return (
    <div className="roads-float">
      <div className="hs-head">
        <span>🛣️</span><span className="hs-title">Road status</span>
        <span className="hs-badge">{blocked} blocked</span>
      </div>
      {!segs.length ? (
        <div className="hs-hint">No flooded stretches in view. Zoom to 13 or closer.</div>
      ) : (
        <div className="hs-list">
          {segs.slice(0, 10).map((s, i) => (
            <button key={i} className="road-row" onClick={() => twin?.flyTo(s.at[0], s.at[1], 16)}>
              <span className={`road-pill ${s.status === 'blocked' ? 'is-blocked' : 'is-caution'}`}>
                {s.maxDepth.toFixed(2)}
              </span>
              <span className="road-name">{s.name}</span>
              <span className="road-len">{Math.round(s.lengthM)} m</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Search ───────────────────────────────────────────────────────────────── */
export function SearchBar({ twin }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const t = useRef(null);

  useEffect(() => {
    clearTimeout(t.current);
    if (q.trim().length < 2) { setItems([]); return; }
    t.current = setTimeout(() => {
      fetch('/api/geocode/autocomplete?q=' + encodeURIComponent(q))
        .then((r) => (r.ok ? r.json() : { suggestions: [] }))
        .then((d) => setItems(d.suggestions || []))
        .catch(() => setItems([]));
    }, 220);
    return () => clearTimeout(t.current);
  }, [q]);

  const pick = async (it) => {
    setItems([]); setQ(it.main);
    try {
      const d = await fetch('/api/geocode/place?id=' + encodeURIComponent(it.placeId)).then((r) => r.json());
      if (d.lat && d.lng) twin?.flyTo(d.lng, d.lat, 16.5);
    } catch { /* ignore */ }
  };

  return (
    <div className="search">
      <span className="search-icon">🔍</span>
      <input
        value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Search a place in Gurugram…" spellCheck={false} autoComplete="off"
      />
      {items.length > 0 && (
        <ul className="search-list">
          {items.map((it) => (
            <li key={it.placeId}><button onClick={() => pick(it)}>
              <b>{it.main}</b><span>{it.secondary}</span>
            </button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
