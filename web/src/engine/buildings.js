/* ─────────────────────────────────────────────────────────────────────────────
 * buildings.js — independent toggle for the basemap's 3-D buildings.
 *
 * The extruded buildings are the Mappls vector style's own `fill-extrusion`
 * layers, not something we add — so the toggle works by collecting those layer
 * ids and flipping their visibility. Two things make that less trivial than it
 * sounds:
 *
 *  • The style has a parallel "_sea" stack of extrusions near the BOTTOM of the
 *    layer order (coast/sea variants). They are not buildings; leaving them
 *    alone keeps the coastline intact when buildings are off.
 *  • Mappls re-emits its style on `styledata`, which resurrects visibility we
 *    set earlier — so the choice is re-asserted on every style event rather than
 *    applied once.
 * ─────────────────────────────────────────────────────────────────────────── */
import { addLayerSafe, FONT_REGULAR } from './core.js';

export function createBuildings(engine) {
  const { map } = engine;
  let on = true;
  let ids = [];

  function collect() {
    const order = map.style?._order || [];
    ids = order.filter((id) => {
      const l = map.getLayer(id);
      return l && l.type === 'fill-extrusion' && !/sea/i.test(id);
    });
    return ids;
  }

  // Re-entrancy guard: setLayoutProperty can itself emit `styledata`, and the
  // handler below calls straight back into apply().
  let applying = false;
  function apply() {
    if (applying) return;
    applying = true;
    try {
      collect();
      const want = on ? 'visible' : 'none';
      for (const id of ids) {
        try {
          if ((map.getLayoutProperty(id, 'visibility') || 'visible') !== want) {
            map.setLayoutProperty(id, 'visibility', want);
          }
        } catch { /* layer churned mid-restyle */ }
      }
    } finally { applying = false; }
  }

  // Re-assert after the style pipeline settles.
  const onStyle = () => apply();
  map.on('styledata', onStyle);
  apply();

  return {
    get count() { return ids.length; },
    setVisible(v) { on = v; apply(); engine.triggerRepaint(); },
    dispose() { map.off('styledata', onStyle); },
  };
}

/* ── Ward boundaries ───────────────────────────────────────────────────────── */
const WARD_LAYERS = ['wards-line', 'wards-label'];

// The source file stores rings as [lat,lng]; GeoJSON wants [lng,lat].
const swapLL = (g) => (typeof g[0] === 'number' ? [g[1], g[0]] : g.map(swapLL));

export async function createWards(engine) {
  const { map } = engine;
  const geo = await fetch('/wards_gurugram.geojson').then((r) => {
    if (!r.ok) throw new Error(`wards HTTP ${r.status}`);
    return r.json();
  });
  const fixed = {
    type: 'FeatureCollection',
    features: (geo.features || []).map((f) => ({
      type: 'Feature',
      properties: f.properties,
      geometry: { type: f.geometry.type, coordinates: swapLL(f.geometry.coordinates) },
    })),
  };
  if (!map.getSource('wards-src')) map.addSource('wards-src', { type: 'geojson', data: fixed });
  if (!map.getLayer('wards-line')) {
    addLayerSafe(map, {
      id: 'wards-line', type: 'line', source: 'wards-src',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#475569', 'line-width': 1.6, 'line-opacity': 0.8, 'line-dasharray': [4, 2] },
    });
  }
  if (!map.getLayer('wards-label')) {
    addLayerSafe(map, {
      id: 'wards-label', type: 'symbol', source: 'wards-src', minzoom: 12,
      layout: {
        visibility: 'none',
        'text-field': ['coalesce', ['get', 'ward_lgd_name'], ['to-string', ['get', 'ward_lgd_code']]],
        'text-size': 11,
        'text-font': FONT_REGULAR,
      },
      paint: { 'text-color': '#334155', 'text-halo-color': 'rgba(255,255,255,.9)', 'text-halo-width': 1.2 },
    });
  }
  return {
    count: fixed.features.length,
    setVisible(on) {
      for (const id of WARD_LAYERS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      }
    },
    dispose() {
      for (const id of WARD_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource('wards-src')) map.removeSource('wards-src');
    },
  };
}
