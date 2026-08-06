/* ─────────────────────────────────────────────────────────────────────────────
 * roadsLayer.js — road passability under the current flood frame.
 *
 * Road geometry comes from the Mappls basemap's own rendered line features
 * (real OSM/Mappls road network, deduplicated across tile clips), sampled at a
 * zoom-dependent interval. Each sample's depth is read straight from the coupled
 * run's 768² grid, so passability is the SAME field as the flood sheet and the
 * pipes — not a second, differently-derived estimate.
 *
 * This used to ray-cast every sample against ~100k flood polygons decoded from a
 * 27 MB download. A bilinear grid lookup is O(1), needs no extra bytes on the
 * wire, and is what let coordinates.bin be dropped from the cold load entirely.
 * ─────────────────────────────────────────────────────────────────────────── */

export const ROAD_CAUTION_M = 0.05;
export const ROAD_BLOCKED_M = 0.30;
const ROAD_MIN_ZOOM = 13;
const SRC = 'flooded-roads';
const LAYERS = ['flooded-roads-fill', 'flooded-roads-dash'];

const LAYER_EXCLUDE = /label|symbol|text|icon|aeroway|ferry|rail|waterway|landuse|boundary|transit|tunnel.*casing|bridge.*casing/i;
const MINOR_CLS = /service|parking|footway|cycleway|path|pedestrian|track|steps|alley|driveway/i;
const MAX_WAYS = 5000;

function distM(a, b) {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, s)));
}

function sampleLine(coords, stepM) {
  const pts = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const n = Math.max(1, Math.round(distM(a, b) / stepM));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return pts;
}

export function createRoadsLayer(engine, { depthAt, onSegments }) {
  const { map } = engine;
  let cache = null;
  let visible = false;

  if (!map.getSource(SRC)) {
    map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }

  const firstExtrusion = () => {
    try {
      const layers = map.getStyle()?.layers || [];
      return (layers.find((l) => l.type === 'fill-extrusion' && !/_sea$/.test(l.id))
        || layers.find((l) => l.type === 'fill-extrusion'))?.id;
    } catch { return undefined; }
  };

  if (!map.getLayer('flooded-roads-fill')) {
    const anchor = firstExtrusion();
    map.addLayer({
      id: 'flooded-roads-fill', type: 'line', source: SRC,
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case',
          ['>=', ['get', 'maxDepth'], 0.60], '#dc2626',
          ['>=', ['get', 'maxDepth'], 0.30], '#f97316',
          '#fbbf24'],
        'line-width': ['interpolate', ['linear'], ['get', 'maxDepth'], 0.10, 5, 2.0, 12],
        'line-opacity': 0.6,
      },
    }, anchor);
    map.addLayer({
      id: 'flooded-roads-dash', type: 'line', source: SRC,
      layout: { visibility: 'none', 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': '#fff', 'line-width': 1.5, 'line-opacity': 0.35, 'line-dasharray': [3, 5] },
    }, anchor);
  }

  // Keep the overlay ABOVE the water but BEHIND the buildings, so at a pitch the
  // buildings genuinely occlude it. Native fill-extrusions share MapLibre's depth
  // buffer with 2-D layers, so ordering before the first extrusion is what buys
  // that occlusion. Re-asserted because the style reshuffles as tiles stream in.
  const reanchor = () => {
    if (!map.getLayer('flooded-roads-fill')) return;
    const before = firstExtrusion();
    try {
      if (map.getLayer('ft-scene')) map.moveLayer('ft-scene', before);
      map.moveLayer('flooded-roads-fill', before);
      map.moveLayer('flooded-roads-dash', before);
    } catch { /* next styledata retries */ }
  };
  map.on('styledata', reanchor);
  reanchor();

  const stepM = () => {
    const z = map.getZoom();
    return z >= 14 ? 12 : z >= 13 ? 20 : z >= 12 ? 40 : z >= 11 ? 80 : 160;
  };

  function buildCache() {
    if (map.getZoom() < ROAD_MIN_ZOOM) { cache = []; return; }
    let layerIds;
    try {
      layerIds = map.getStyle().layers.filter((l) => l.type === 'line' && !LAYER_EXCLUDE.test(l.id)).map((l) => l.id);
    } catch { return; }
    if (!layerIds.length) return;
    const raw = map.queryRenderedFeatures(undefined, { layers: layerIds });
    const seen = new Set(), out = [], step = stepM();
    for (const f of raw) {
      if (out.length >= MAX_WAYS) break;
      const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates]
        : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      const name = f.properties?.name || f.properties?.ref || '';
      const cls = (f.properties?.class || f.properties?.road_class || f.properties?.type || f.properties?.highway || '').toLowerCase();
      if (cls && MINOR_CLS.test(cls)) continue;
      for (const line of lines) {
        if (line.length < 2) continue;
        const key = `${line[0][0].toFixed(5)},${line[0][1].toFixed(5)}|`
          + `${line[line.length - 1][0].toFixed(5)},${line[line.length - 1][1].toFixed(5)}|${line.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ pts: sampleLine(line, step), name, cls });
        if (out.length >= MAX_WAYS) break;
      }
    }
    cache = out;
  }

  /** Split each way into contiguous wet stretches, one feature per stretch. */
  function analyse() {
    if (!visible) return;
    if (!cache) buildCache();
    const features = [], segs = [];
    for (const { pts, name, cls } of cache || []) {
      let inFlood = false, seg = [], maxD = 0;
      const flush = () => {
        if (seg.length < 2) return;
        const status = maxD >= ROAD_BLOCKED_M ? 'blocked' : 'caution';
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: seg },
          properties: { name, cls, maxDepth: maxD, status },
        });
        let len = 0;
        for (let i = 1; i < seg.length; i++) len += distM(seg[i - 1], seg[i]);
        segs.push({ name: name || 'Unnamed road', cls, maxDepth: maxD, status, lengthM: len,
          at: seg[Math.floor(seg.length / 2)] });
      };
      for (const pt of pts) {
        const d = depthAt(pt[0], pt[1]);
        if (d >= ROAD_CAUTION_M) {
          if (!inFlood) { inFlood = true; seg = []; maxD = 0; }
          if (d > maxD) maxD = d;
          seg.push(pt);
        } else if (inFlood) { inFlood = false; flush(); }
      }
      if (inFlood) flush();
    }
    map.getSource(SRC)?.setData({ type: 'FeatureCollection', features });
    // Worst first, and merge repeats of the same road name so the panel lists
    // roads rather than the arbitrary tile fragments they were queried as.
    const byName = new Map();
    for (const s of segs) {
      const k = s.name + '|' + s.status;
      const e = byName.get(k);
      if (!e) byName.set(k, { ...s });
      else { e.lengthM += s.lengthM; e.maxDepth = Math.max(e.maxDepth, s.maxDepth); }
    }
    const list = [...byName.values()].sort((a, b) => b.maxDepth - a.maxDepth).slice(0, 40);
    onSegments?.(list);
  }

  let raf = null;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; analyse(); });
  };
  const onMoveEnd = () => {
    if (!visible) return;
    if (map.getZoom() < ROAD_MIN_ZOOM) { cache = []; onSegments?.([]); return; }
    cache = null;
    schedule();
  };
  map.on('moveend', onMoveEnd);

  const onClick = (e) => {
    const p = e.features?.[0]?.properties;
    if (!p) return;
    new window.maplibregl.Popup({ offset: 8 }).setLngLat(e.lngLat).setHTML(
      `<div class="ft-pop"><b>🛣️ ${p.name || 'Road'}</b>` +
      `<div class="ft-pop-name">${(+p.maxDepth).toFixed(2)} m at the deepest point</div>` +
      `<div class="ft-pop-risk ${p.status === 'blocked' ? 'ft-risk-hi' : 'ft-risk-mid'}">` +
      `${p.status === 'blocked' ? 'Impassable for cars' : 'Passable with caution'}</div></div>`
    ).addTo(map);
  };
  map.on('click', 'flooded-roads-fill', onClick);
  map.on('mouseenter', 'flooded-roads-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'flooded-roads-fill', () => { map.getCanvas().style.cursor = ''; });

  return {
    minZoom: ROAD_MIN_ZOOM,
    setVisible(on) {
      visible = on;
      for (const id of LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      if (on) { cache = null; schedule(); } else onSegments?.([]);
    },
    refresh: schedule,
    dispose() {
      map.off('moveend', onMoveEnd);
      map.off('styledata', reanchor);
      map.off('click', 'flooded-roads-fill', onClick);
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    },
  };
}
