/* ─────────────────────────────────────────────────────────────────────────────
 * LayersPanel.jsx — every feature toggle, in one place, without a scrollbar.
 *
 * Rendered entirely from features/registry.js, so this component knows nothing
 * about what any switch does — it only reads and writes store flags. That is
 * what makes the independence contract structural rather than a convention: a
 * row cannot reach another feature even if it wanted to.
 *
 * Two decisions keep the whole catalogue on one screen:
 *   • Rows are single-line. The descriptive text moved to the row's tooltip; the
 *     right-hand slot carries the one number that matters (asset count, km of
 *     sewer, conduits) instead of a second line of prose.
 *   • Sub-layers open in a POPOVER pinned beside the row, not inline. Expanding
 *     "Storm-drain network" used to push eleven rows into the column and force
 *     the scrollbar the panel exists to avoid; now the panel height is constant.
 *
 * View aids (tilt, x-ray) are deliberately absent — they are map buttons at the
 * bottom right, and duplicating them here cost rows for no reach.
 * ─────────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PANEL_GROUPS, PANEL_FEATURES, panelFeaturesInGroup } from '../features/registry.js';
import { useTwin } from '../store/useTwin.js';
import { onLayerIntent } from '../warmConsole.js';

function ChildRow({ parentId, child, count }) {
  const key = `${parentId}.${child.id}`;
  const value = useTwin((s) => s.features[key]);
  const toggle = useTwin((s) => s.toggleFeature);
  const resetAuto = useTwin((s) => s.resetChildAuto);
  const isAuto = value === 'auto';
  const on = isAuto || value === true;

  return (
    <div className={`lyr-child${on ? '' : ' is-off'}`}>
      <button
        type="button" className="lyr-child-main" onClick={() => toggle(key)}
        aria-pressed={on} title={child.hint || child.label}
      >
        <span className="lyr-check" aria-hidden="true">{on ? '✓' : ''}</span>
        <span className="lyr-child-label">{child.label}</span>
        {count != null && <span className="lyr-count">{count.toLocaleString()}</span>}
      </button>
      {child.auto && (
        <button
          type="button" className={`lyr-auto${isAuto ? ' is-on' : ''}`}
          onClick={() => (isAuto ? toggle(key) : resetAuto(key))}
          title={isAuto ? 'Visibility follows zoom — click to pin' : 'Hand back to the zoom rule'}
        >auto</button>
      )}
    </div>
  );
}

/** Sub-layer popover, portalled to <body> so it floats over the map. */
function ChildPopover({ feature, anchor, onClose, childCount }) {
  const setGroupAll = useTwin((s) => s.setGroupAll);
  const parentOn = useTwin((s) => !!s.features[feature.id]);
  const ref = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const h = ref.current.offsetHeight;
    // Keep it on screen: prefer top-aligned with the row, slide up if it would
    // run off the bottom.
    const top = Math.max(8, Math.min(a.top, window.innerHeight - h - 8));
    setPos({ top, left: a.right + 8 });
  }, [anchor]);

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current?.contains(e.target) || anchor?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [anchor, onClose]);

  const keys = feature.children.map((c) => `${feature.id}.${c.id}`);
  return createPortal(
    <div className="lyr-pop" ref={ref} style={{ top: pos.top, left: pos.left }} role="dialog">
      <div className="lyr-pop-head">
        <span>{feature.icon} {feature.label}</span>
        <button onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="lyr-pop-sub">
        <span>{feature.children.length} sub-layers</span>
        <span className="lyr-children-btns">
          <button onClick={() => setGroupAll(keys, true)}>All</button>
          <button onClick={() => setGroupAll(keys, false)}>None</button>
        </span>
      </div>
      <div className="lyr-pop-body">
        {feature.children.map((c) => (
          <ChildRow key={c.id} parentId={feature.id} child={c} count={childCount(c.id)} />
        ))}
      </div>
      {!parentOn && <div className="lyr-pop-note">Switch the layer on to see these on the map.</div>}
    </div>,
    document.body
  );
}

function FeatureRow({ feature, openId, setOpenId }) {
  const on = useTwin((s) => !!s.features[feature.id]);
  const status = useTwin((s) => s.featureStatus[feature.id]);
  const error = useTwin((s) => s.featureError[feature.id]);
  const toggle = useTwin((s) => s.toggleFeature);
  const assetCounts = useTwin((s) => s.assetCounts);
  const drainStats = useTwin((s) => s.drainStats);
  const sewerStats = useTwin((s) => s.sewerStats);
  const btnRef = useRef(null);
  const open = openId === feature.id;

  const childCount = (cid) => {
    if (feature.id === 'assets') return assetCounts?.[cid];
    if (feature.id === 'drainage' && drainStats?.tiers) {
      const c = { storm: 0, sewer: 1, unclass: 2 }[cid];
      if (c != null) return drainStats.classes?.[c];
      const i = { trunk: 0, main: 1, lateral: 2 }[cid];
      if (i != null) return drainStats.tiers[i];
      if (cid === 'inlets') return drainStats.inlets;
      if (cid === 'outfalls') return drainStats.outfalls;
      if (cid === 'pumps') return drainStats.pumps;
    }
    return undefined;
  };

  // One number, not a sentence — the prose lives in the tooltip.
  const stat =
    feature.id === 'sewer' && sewerStats ? `${Math.round(sewerStats.km).toLocaleString()} km`
    : feature.id === 'drainage' && drainStats ? `${(drainStats.links / 1000).toFixed(0)}k`
    : feature.id === 'assets' && Object.keys(assetCounts || {}).length
      ? Object.values(assetCounts).reduce((a, b) => a + b, 0).toLocaleString()
    : null;

  const title = status === 'error' ? `${error} — click to retry` : `${feature.label} — ${feature.short}`;

  return (
    <div className={`lyr-feature${on ? ' is-on' : ''}${status === 'error' ? ' is-err' : ''}`}>
      {/* Hovering starts the download and the chunk import for the heavy layers
          (drainage, sewer), so the click lands on warm data instead of paying
          2.4 MB and an import from a standing start. See warmConsole.js. */}
      <button type="button" className="lyr-toggle" onClick={() => toggle(feature.id)}
              {...(on ? {} : onLayerIntent(feature.id))}
              aria-pressed={on} title={title}>
        <span className="lyr-icon">{feature.icon}</span>
        <span className="lyr-label">{feature.label}</span>
        {stat && <span className="lyr-stat">{stat}</span>}
        {status === 'loading'
          ? <span className="lyr-spin" aria-label="loading" />
          : <span className={`lyr-switch${on ? ' is-on' : ''}`} />}
      </button>
      {feature.children && (
        <button
          ref={btnRef} type="button" className={`lyr-expand${open ? ' is-open' : ''}`}
          onClick={() => setOpenId(open ? null : feature.id)}
          title={`${feature.children.length} sub-layers`} aria-label="Sub-layers"
        >▸</button>
      )}
      {open && feature.children && (
        <ChildPopover feature={feature} anchor={btnRef.current}
                      onClose={() => setOpenId(null)} childCount={childCount} />
      )}
    </div>
  );
}

export default function LayersPanel() {
  const [openId, setOpenId] = useState(null);
  return (
    <div className="panel lyr-panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <span className="panel-icon">🎚️</span>
          <span className="panel-title">Layers &amp; Features</span>
        </div>
        <span className="panel-badge" title="Every layer is independent — one never switches another off">
          {PANEL_FEATURES.length} independent
        </span>
      </div>
      {PANEL_GROUPS.map((g) => (
        <section className="lyr-group" key={g.id}>
          <h4 className="lyr-group-title"><span>{g.icon}</span>{g.label}</h4>
          {panelFeaturesInGroup(g.id).map((f) => (
            <FeatureRow key={f.id} feature={f} openId={openId} setOpenId={setOpenId} />
          ))}
        </section>
      ))}
    </div>
  );
}
