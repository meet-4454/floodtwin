/* ─────────────────────────────────────────────────────────────────────────────
 * sewerLayer.js — Gurugram's SEWERAGE network, as an independent map layer.
 *
 * Data: `drainage/web/sewer_network.geojson`, built by build_sewer_network.py
 * from MCG/GMDA's own utility inventory — 113,757 recorded sewer segments welded
 * into 45,787 mains, 1,980 km, carrying the recorded diameter, material, cover
 * depth, inverts and Manning full-flow capacity. Nothing here is modelled or
 * invented; chains with no recorded attribute simply omit that property.
 *
 * Deliberately a 2-D map layer, not a 3-D tube network: the sewer system is
 * separate infrastructure from the storm drains and there is no coupled solution
 * for it, so rendering it as filling pipes would imply hydraulics we do not have.
 * It reads as what it is — a mapped asset inventory you can switch on beside the
 * solved storm network.
 * ─────────────────────────────────────────────────────────────────────────── */

const SRC = 'sewer-src';
export const SEWER_LAYERS = ['sewer-casing', 'sewer-line', 'sewer-major'];

// Sized by recorded diameter so trunk sewers read heavier than 200 mm laterals.
const byDia = (small, big) =>
  ['interpolate', ['linear'], ['coalesce', ['get', 'dia_m'], 0.2], 0.1, small, 1.2, big];
const WIDTH = [
  'interpolate', ['linear'], ['zoom'],
  12, byDia(0.4, 1.6),
  15, byDia(1.0, 4.0),
  18, byDia(2.2, 9.0),
];
const CASING_WIDTH = [
  'interpolate', ['linear'], ['zoom'],
  12, byDia(1.4, 2.8),
  15, byDia(2.4, 5.6),
  18, byDia(4.0, 11.4),
];

export async function createSewerLayer(engine) {
  const { map } = engine;
  const res = await engine.client.raw('/drainage/sewer_network.geojson');
  if (!res.ok) throw new Error(`sewer network not built (HTTP ${res.status}) — run build_sewer_network.py`);
  const geo = await res.json();

  if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: geo });

  // A dark casing under a lighter core: at city zoom 45k overlapping lines merge
  // into a flat wash, and the outline is what keeps individual mains separable.
  if (!map.getLayer('sewer-casing')) {
    map.addLayer({
      id: 'sewer-casing', type: 'line', source: SRC, minzoom: 11,
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#2f2140',
        'line-width': CASING_WIDTH,
        'line-opacity': 0.55,
      },
    });
  }
  if (!map.getLayer('sewer-line')) {
    map.addLayer({
      id: 'sewer-line', type: 'line', source: SRC, minzoom: 11,
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        // Muted violet: distinct from every storm-water hue in the app, so the
        // two networks are never confused when both are on.
        'line-color': [
          'interpolate', ['linear'], ['coalesce', ['get', 'dia_m'], 0.2],
          0.1, '#9d7fd4', 0.45, '#7b5bc4', 1.2, '#5b3fa8',
        ],
        'line-width': WIDTH,
        'line-opacity': 0.85,
      },
    });
  }
  // Trunk sewers (≥450 mm) get a dashed centre-line so the backbone is legible
  // even when the whole network is on.
  if (!map.getLayer('sewer-major')) {
    map.addLayer({
      id: 'sewer-major', type: 'line', source: SRC, minzoom: 13,
      filter: ['>=', ['coalesce', ['get', 'dia_m'], 0], 0.45],
      layout: { visibility: 'none', 'line-cap': 'butt' },
      paint: {
        'line-color': '#e6dcff', 'line-width': 1.0, 'line-opacity': 0.55,
        'line-dasharray': [2, 3],
      },
    });
  }

  const onClick = (e) => {
    const p = e.features?.[0]?.properties || {};
    const fmt = (v, s = '') => (v === undefined || v === null || v === '' ? null : `${v}${s}`);
    const rows = [
      fmt(p.dia_m && `Ø ${Math.round(p.dia_m * 1000)} mm`),
      fmt(p.mat && `${p.mat}`),
      fmt(p.cover_m && `${p.cover_m} m below ground`),
      p.inv_u != null && p.inv_d != null ? `invert ${p.inv_u} → ${p.inv_d} m` : null,
      fmt(p.cap_m3s && `full-flow capacity ${p.cap_m3s} m³/s`),
      fmt(p.len_m && `${Math.round(p.len_m)} m of main (${p.n} recorded segments)`),
      fmt(p.ward), fmt(p.zone),
      fmt(p.desilt && `desilting: ${p.desilt}`),
    ].filter(Boolean);
    new window.maplibregl.Popup({ offset: 8 })
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="ft-pop"><b style="color:#7b5bc4">Sewerage main</b>` +
        rows.map((r) => `<div>${r}</div>`).join('') +
        `<div class="ft-pop-src">MCG/GMDA recorded asset</div></div>`
      )
      .addTo(map);
  };
  const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
  const leave = () => { map.getCanvas().style.cursor = ''; };
  map.on('click', 'sewer-line', onClick);
  map.on('mouseenter', 'sewer-line', enter);
  map.on('mouseleave', 'sewer-line', leave);

  const meta = geo.properties || {};
  return {
    stats: { chains: meta.chains, km: meta.length_km, segments: meta.segments },
    setVisible(on) {
      for (const id of SEWER_LAYERS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      }
    },
    dispose() {
      map.off('click', 'sewer-line', onClick);
      map.off('mouseenter', 'sewer-line', enter);
      map.off('mouseleave', 'sewer-line', leave);
      for (const id of SEWER_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    },
  };
}
