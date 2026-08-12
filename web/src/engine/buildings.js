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

/* ── Ward & district boundaries ─────────────────────────────────────────────
 * One toggle, two administrative levels: the 36 MCG ward polygons and the
 * Gurugram district outline that contains them. They ship as two files because
 * they are two separate surveys, and they are unioned here into ONE source so
 * the toggle can never show half an answer — the wards and the boundary they
 * sit inside appear and disappear together.
 *
 * They are drawn by two line layers rather than one data-driven layer because
 * `line-dasharray` takes no data expression: the district needs a solid casing
 * heavy enough to read as the outer edge, the wards a thin dash that subdivides
 * it without competing with the streets.
 */
const WARD_LAYERS = ['district-line', 'wards-line', 'district-label', 'wards-label'];

async function fetchGeo(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return r.json();
}

// Both files are CRS84 ([lng,lat]) already — the district's third ordinate is a
// constant 0 elevation, which the GeoJSON source ignores.
function tag(geo, kind, label) {
  return (geo.features || []).map((f) => ({
    type: 'Feature',
    properties: { ...f.properties, kind, label: label(f.properties || {}) },
    geometry: f.geometry,
  }));
}

export async function createWards(engine) {
  const { map } = engine;
  const [wardGeo, distGeo] = await Promise.all([
    fetchGeo('/Gurugram_wards.geojson'),
    // A missing district file must not cost us the wards.
    fetchGeo('/Gurugram_district.geojson').catch((e) => {
      console.warn('district boundary unavailable:', e);
      return { features: [] };
    }),
  ]);

  const wards = tag(wardGeo, 'ward', (p) => {
    const no = String(p.MC_Ward_No ?? '').replace(/^0+(?=\d)/, '');
    return no ? `Ward ${no}` : '';
  });
  const district = tag(distGeo, 'district', (p) => {
    const name = String(p.DISTRICT ?? 'Gurugram').trim();
    return `${name.charAt(0) + name.slice(1).toLowerCase()} district`;
  });
  const merged = { type: 'FeatureCollection', features: [...wards, ...district] };

  if (!map.getSource('wards-src')) map.addSource('wards-src', { type: 'geojson', data: merged });
  if (!map.getLayer('district-line')) {
    addLayerSafe(map, {
      id: 'district-line', type: 'line', source: 'wards-src',
      filter: ['==', ['get', 'kind'], 'district'],
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: { 'line-color': '#334155', 'line-width': 2.6, 'line-opacity': 0.9 },
    });
  }
  if (!map.getLayer('wards-line')) {
    addLayerSafe(map, {
      id: 'wards-line', type: 'line', source: 'wards-src',
      filter: ['==', ['get', 'kind'], 'ward'],
      layout: { visibility: 'none' },
      paint: { 'line-color': '#475569', 'line-width': 1.6, 'line-opacity': 0.8, 'line-dasharray': [4, 2] },
    });
  }
  // The district name rides ALONG its boundary rather than sitting at the
  // centroid, where it would land on top of the city and fight the wards.
  if (!map.getLayer('district-label')) {
    addLayerSafe(map, {
      id: 'district-label', type: 'symbol', source: 'wards-src', maxzoom: 12,
      filter: ['==', ['get', 'kind'], 'district'],
      layout: {
        visibility: 'none',
        'text-field': ['get', 'label'],
        'text-size': 12,
        'text-font': FONT_REGULAR,
        'symbol-placement': 'line',
        'text-letter-spacing': 0.08,
      },
      paint: { 'text-color': '#334155', 'text-halo-color': 'rgba(255,255,255,.9)', 'text-halo-width': 1.4 },
    });
  }
  if (!map.getLayer('wards-label')) {
    addLayerSafe(map, {
      id: 'wards-label', type: 'symbol', source: 'wards-src', minzoom: 12,
      filter: ['==', ['get', 'kind'], 'ward'],
      layout: {
        visibility: 'none',
        'text-field': ['get', 'label'],
        'text-size': 11,
        'text-font': FONT_REGULAR,
      },
      paint: { 'text-color': '#334155', 'text-halo-color': 'rgba(255,255,255,.9)', 'text-halo-width': 1.2 },
    });
  }
  return {
    // The count the panel shows is the ward count — the district is the frame
    // around them, not a 37th ward.
    count: wards.length,
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
