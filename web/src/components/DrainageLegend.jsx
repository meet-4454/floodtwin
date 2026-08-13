/* ─────────────────────────────────────────────────────────────────────────────
 * DrainageLegend.jsx — the key for everything the drainage layer puts on the map.
 *
 * Every row IS its sub-layer's toggle. A legend that only explains symbols makes
 * you go hunting in the sidebar to act on what you just read; here the swatch,
 * the name, the count and the switch are the same control. Appears only while
 * the drainage layer is on, and disappears with it.
 *
 * The marker shapes mirror the map exactly: angular, infrastructure-coloured
 * shapes for drainage, so nothing here can be confused with the round lettered
 * dots the critical-asset layer uses.
 * ─────────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { useTwin } from '../lib/context.jsx';

const ROWS = [
  { id: 'storm',     label: 'Storm conduits',  mk: 'pipe',  c: '#339ee6' },
  { id: 'sewer',     label: 'Sewer conduits',  mk: 'pipe',  c: '#8c61c7' },
  { id: 'unclass',   label: 'Unclassified',    mk: 'pipe',  c: '#738594' },
  { id: 'water',     label: 'Water in pipes',  mk: 'ramp' },
  { id: 'shafts',    label: 'Manholes',        mk: 'shaft' },
  { id: 'surcharge', label: 'Surcharging',     mk: 'dot',   c: '#ff5a3c' },
  { id: 'inlets',    label: 'Side-entry pits', mk: 'sq',    c: '#1f4a63' },
  { id: 'outfalls',  label: 'Outfalls',        mk: 'tri',   c: '#0f766e' },
  { id: 'pumps',     label: 'Storm pumps',     mk: 'psq',   c: '#57534e' },
];

function Marker({ mk, c }) {
  if (mk === 'ramp') return <span className="dk-mk dk-ramp" />;
  if (mk === 'shaft') return <span className="dk-mk dk-shaft" />;
  if (mk === 'tri') return <span className="dk-mk dk-tri" style={{ borderBottomColor: c }} />;
  if (mk === 'sq') return <span className="dk-mk dk-sq" style={{ background: c }} />;
  if (mk === 'psq') return <span className="dk-mk dk-psq" style={{ background: c }} />;
  if (mk === 'dot') return <span className="dk-mk dk-dot" style={{ background: c }} />;
  return <span className="dk-mk dk-pipe" style={{ background: c }} />;
}

export default function DrainageLegend() {
  const on = useTwin((s) => s.features.drainage);
  const features = useTwin((s) => s.features);
  const toggle = useTwin((s) => s.toggleFeature);
  const stats = useTwin((s) => s.drainStats);
  const surcharged = useTwin((s) => s.surcharged);
  if (!on) return null;

  const count = (id) => {
    if (!stats) return null;
    const c = { storm: 0, sewer: 1, unclass: 2 }[id];
    if (c != null) return stats.classes?.[c];
    if (id === 'inlets') return stats.inlets;
    if (id === 'outfalls') return stats.outfalls;
    if (id === 'pumps') return stats.pumps;
    if (id === 'shafts') return stats.shafts;
    if (id === 'surcharge') return surcharged;
    return null;
  };

  return (
    <div className="drain-key">
      <div className="dk-head">
        <span>🚇</span><span className="dk-title">Drainage key</span>
        <span className="dk-badge">tap to toggle</span>
      </div>
      {ROWS.map((r) => {
        const v = features[`drainage.${r.id}`];
        const isOn = v === 'auto' || v === true;
        const n = count(r.id);
        return (
          <button
            key={r.id}
            className={`dk-row${isOn ? '' : ' is-off'}`}
            onClick={() => toggle(`drainage.${r.id}`)}
            aria-pressed={isOn}
          >
            <Marker mk={r.mk} c={r.c} />
            <span className="dk-label">{r.label}</span>
            {n != null && <span className="dk-count">{n.toLocaleString()}</span>}
          </button>
        );
      })}
      <div className="dk-note">
        Water stands from each invert up at the solved depth in metres, so every
        conduit at a manhole shares one water surface and a deeper drain holds
        visibly more than the conduit above it; a full round bore is at capacity.
        Manhole columns rise to the street when a node surcharges.
      </div>
    </div>
  );
}
