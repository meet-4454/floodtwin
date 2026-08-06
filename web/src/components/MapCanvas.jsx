/* MapCanvas — mounts the imperative engine once and renders the DOM overlays
 * that ride on top of it (hotspot beacons, the depth probe). React owns the
 * overlays; the engine owns the pixels. */
import React, { useEffect, useRef, useState } from 'react';
import { useTwin } from '../store/useTwin.js';
import { colorForDepth } from '../engine/palette.js';

export default function MapCanvas({ onReady }) {
  const hostRef = useRef(null);
  const twinRef = useRef(null);
  const [probe, setProbe] = useState(null);
  const [beacons, setBeacons] = useState([]);
  const hotspots = useTwin((s) => s.hotspots);
  const showHotspots = useTwin((s) => s.features.hotspots);
  const maxDepth = useTwin((s) => s.maxDepth);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { startTwin } = await import('../engine/controller.js');
        const twin = await startTwin({ container: 'ft-map' });
        if (cancelled) { twin.destroy(); return; }
        twinRef.current = twin;
        // The boot overlay covers the map while it initialises; once it is gone
        // the container's final box is known, so re-measure. Two frames because
        // the overlay unmounts on the same commit as `phase: ready`.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try { twin.engine.map.resize(); } catch { /* torn down */ }
        }));
        onReady?.(twin);
      } catch (e) {
        console.error(e);
        useTwin.getState().setError(e.message || String(e));
      }
    })();
    return () => { cancelled = true; twinRef.current?.destroy(); twinRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Depth probe: the engine emits a DOM event so it never has to know React.
  useEffect(() => {
    const onProbe = (e) => {
      const { lng, lat, depth, point } = e.detail;
      setProbe(depth > 0.02 ? { lng, lat, depth, x: point.x, y: point.y } : null);
    };
    window.addEventListener('ft:probe', onProbe);
    return () => window.removeEventListener('ft:probe', onProbe);
  }, []);

  // Keep beacons glued to their lng/lat as the camera moves.
  useEffect(() => {
    const twin = twinRef.current;
    if (!twin || !showHotspots) { setBeacons([]); return; }
    const map = twin.engine.map;
    const place = () => {
      setBeacons(hotspots.map((s, i) => {
        let p = { x: -9999, y: -9999 };
        try { p = map.project({ lat: s.lat, lng: s.lng }); } catch { /* pre-style */ }
        return { ...s, i, x: p.x, y: p.y };
      }));
    };
    place();
    map.on('move', place);
    map.on('resize', place);
    return () => { map.off('move', place); map.off('resize', place); };
  }, [hotspots, showHotspots]);

  return (
    <div className="map-shell">
      <div id="ft-map" ref={hostRef} className="map-host" />

      {beacons.map((b) => (
        <button
          key={b.i}
          type="button"
          className="beacon"
          style={{
            transform: `translate3d(${b.x}px, ${b.y}px, 0) translate(-50%, -50%)`,
            '--beacon-color': colorForDepth(b.max, maxDepth),
          }}
          onClick={() => setProbe({ lng: b.lng, lat: b.lat, depth: b.max, x: b.x, y: b.y })}
          title={`Hotspot ${b.i + 1} — ${b.max.toFixed(2)} m deepest`}
        >
          <span className="beacon-ring" />
          <span className="beacon-ring beacon-ring--2" />
          <span className="beacon-core">{b.i + 1}</span>
        </button>
      ))}

      {probe && (
        <div className="probe" style={{ transform: `translate3d(${probe.x}px, ${probe.y}px, 0)` }}>
          <button className="probe-close" onClick={() => setProbe(null)} aria-label="Close">✕</button>
          <div className="probe-head">💧 Flood depth</div>
          <div className="probe-val">
            <b style={{ color: colorForDepth(probe.depth, maxDepth) }}>{probe.depth.toFixed(2)}</b>
            <span>metres</span>
          </div>
          <div className="probe-meta">{probe.lat.toFixed(5)}, {probe.lng.toFixed(5)}</div>
        </div>
      )}
    </div>
  );
}
