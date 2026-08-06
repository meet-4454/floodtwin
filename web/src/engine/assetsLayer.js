/* ─────────────────────────────────────────────────────────────────────────────
 * assetsLayer.js — critical assets, grouped by zoom.
 *
 * Source: /api/assets — Google Places (New) `searchNearby`, grid-tiled 4×4 over
 * the Gurugram bbox and deduped by place id so coverage approaches "every asset"
 * rather than "the 20 most prominent"; falls back to OSM/Overpass when the
 * Google key is unconfigured. ~1,300 real POIs.
 *
 * These were 1,300 absolutely-positioned DOM markers, repositioned on every map
 * move — the single worst interaction cost in the app, and visually an
 * unreadable pile-up at city zoom. They are now ONE clustered GeoJSON source:
 * MapLibre re-groups them per zoom on a worker, a group shows how many assets it
 * contains, and clicking it zooms to exactly where that group breaks apart.
 * Toggling a category rebuilds the source, so a group's count always means
 * "assets you asked to see here".
 *
 * THE FETCH NEVER BLOCKS THE TOGGLE. This used to `await` /api/assets before it
 * created a single layer, so flicking the switch on a cold cache froze the whole
 * feature mount behind an upstream API — and a hiccup there threw, which the
 * console surfaced as a hard mount failure. Now the source and all five layers
 * are built immediately against an empty collection, the handle comes back at
 * once, and the data is poured in when it lands (retried with backoff, and the
 * server answers from a warm disk cache anyway). Turning the layer on before the
 * assets arrive is fine: they simply appear, and the counts update in place.
 * ─────────────────────────────────────────────────────────────────────────── */
import { addLayerSafe, FONT_REGULAR, FONT_BOLD } from './core.js';

// `glyph` is a single Open Sans character drawn inside the dot. Drainage assets
// use angular shapes (squares, triangles) in an infrastructure palette; critical
// assets are round, lettered and brightly coloured, so the two families are never
// mistaken for each other on a dense map.
export const CRITICAL_ASSETS = [
  { key: 'hospital',     label: 'Hospitals',       icon: '🏥', accent: '#dc2626', glyph: 'H' },
  { key: 'school',       label: 'Schools',         icon: '🏫', accent: '#059669', glyph: 'S' },
  { key: 'college',      label: 'Colleges',        icon: '🎓', accent: '#0891b2', glyph: 'C' },
  { key: 'fire_station', label: 'Fire Stations',   icon: '🚒', accent: '#ea580c', glyph: 'F' },
  { key: 'police',       label: 'Police Stations', icon: '🚔', accent: '#4f46e5', glyph: 'P' },
  { key: 'pharmacy',     label: 'Pharmacies',      icon: '💊', accent: '#7c3aed', glyph: 'R' },
];

// Deliberately tighter than the district so markers stay in-city and don't pull
// prominent south-Delhi POIs (AIIMS, Saket, Kapashera) into a Gurugram console.
const GURUGRAM_BBOX = '28.37,76.95,28.51,77.10';

const SRC = 'assets-src';
const LAYERS = ['assets-cluster', 'assets-cluster-count', 'assets-point', 'assets-point-glyph', 'assets-point-label'];

const EMPTY = { type: 'FeatureCollection', features: [] };

export async function createAssetsLayer(engine, { onDepthAt, onCounts, onStatus } = {}) {
  const { map } = engine;

  const byCat = Object.fromEntries(CRITICAL_ASSETS.map((c) => [c.key, []]));
  const counts = Object.fromEntries(CRITICAL_ASSETS.map((c) => [c.key, 0]));
  let loadState = 'loading';        // loading | ready | failed
  const enabled = new Set();

  function fc() {
    const features = [];
    for (const cfg of CRITICAL_ASSETS) {
      if (!enabled.has(cfg.key)) continue;
      for (const l of byCat[cfg.key]) {
        features.push({
          type: 'Feature',
          properties: { cat: cfg.key, name: l.name || 'Unnamed', addr: l.address || '',
                        icon: cfg.icon, glyph: cfg.glyph },
          geometry: { type: 'Point', coordinates: [l.lng, l.lat] },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  if (!map.getSource(SRC)) {
    map.addSource(SRC, {
      type: 'geojson',
      data: EMPTY,
      cluster: true,
      // 46 px ≈ two pin widths: tight enough that a group always corresponds to
      // a place you'd point at, loose enough to actually declutter at z12.
      clusterRadius: 46,
      clusterMaxZoom: 16,
      clusterProperties: Object.fromEntries(
        CRITICAL_ASSETS.map((c) => [c.key, ['+', ['case', ['==', ['get', 'cat'], c.key], 1, 0]]])
      ),
    });
  }

  const catColour = ['match', ['get', 'cat'],
    ...CRITICAL_ASSETS.flatMap((c) => [c.key, c.accent]), '#64748b'];

  if (!map.getLayer('assets-cluster')) {
    addLayerSafe(map, {
      id: 'assets-cluster', type: 'circle', source: SRC, filter: ['has', 'point_count'],
      layout: { visibility: 'none' },
      paint: {
        // Size and weight step with how many assets the group holds, so density
        // is readable before you ever open a label.
        'circle-radius': ['step', ['get', 'point_count'], 15, 5, 19, 15, 24, 40, 30, 100, 37],
        'circle-color': ['step', ['get', 'point_count'], '#2b8fb3', 15, '#1d6f96', 40, '#155a7c', 100, '#0f4260'],
        'circle-opacity': 0.92,
        'circle-stroke-width': 2.5,
        'circle-stroke-color': 'rgba(255,255,255,.9)',
      },
    });
  }
  if (!map.getLayer('assets-cluster-count')) {
    addLayerSafe(map, {
      id: 'assets-cluster-count', type: 'symbol', source: SRC, filter: ['has', 'point_count'],
      layout: {
        visibility: 'none',
        'text-field': ['get', 'point_count_abbreviated'],
        'text-size': ['step', ['get', 'point_count'], 12, 15, 13, 40, 15],
        'text-allow-overlap': true,
        // MUST be explicit. MapLibre's default stack is
        // "Open Sans Regular,Arial Unicode MS Regular", and the Mappls glyph CDN
        // 403s that composite stack — a symbol layer without this renders no
        // text at all, which for a cluster bubble means no count.
        'text-font': FONT_BOLD,
      },
      paint: { 'text-color': '#ffffff' },
    });
  }
  if (!map.getLayer('assets-point')) {
    addLayerSafe(map, {
      id: 'assets-point', type: 'circle', source: SRC, filter: ['!', ['has', 'point_count']],
      layout: { visibility: 'none' },
      paint: {
        // Bigger, ringed dots — a POI pin, visibly a different family from the
        // small dark squares and triangles the drainage layer uses.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 5.5, 16, 9, 19, 11],
        'circle-color': catColour,
        'circle-opacity': 0.96,
        'circle-stroke-width': 2.2,
        'circle-stroke-color': '#ffffff',
      },
    });
  }
  if (!map.getLayer('assets-point-glyph')) {
    addLayerSafe(map, {
      id: 'assets-point-glyph', type: 'symbol', source: SRC,
      filter: ['!', ['has', 'point_count']], minzoom: 13,
      layout: {
        visibility: 'none', 'text-field': ['get', 'glyph'], 'text-size': 10,
        'text-allow-overlap': true, 'text-font': FONT_BOLD,
      },
      paint: { 'text-color': '#ffffff' },
    });
  }
  if (!map.getLayer('assets-point-label')) {
    addLayerSafe(map, {
      id: 'assets-point-label', type: 'symbol', source: SRC,
      filter: ['!', ['has', 'point_count']],
      // Names only once the group has fully broken apart — showing 1,300 labels
      // at once is exactly the pile-up clustering exists to prevent.
      minzoom: 15.5,
      layout: {
        visibility: 'none',
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-max-width': 9,
        'text-optional': true,
        'text-font': FONT_REGULAR,
      },
      paint: {
        'text-color': '#1f2f3d',
        'text-halo-color': 'rgba(255,255,255,.95)',
        'text-halo-width': 1.4,
      },
    });
  }

  // Click a group → zoom to exactly where it splits.
  const onCluster = (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const id = f.properties.cluster_id;
    map.getSource(SRC).getClusterExpansionZoom(id, (err, z) => {
      if (err) return;
      map.easeTo({ center: f.geometry.coordinates, zoom: z + 0.2, duration: 600 });
    });
  };
  const onPoint = (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const p = f.properties;
    const cfg = CRITICAL_ASSETS.find((c) => c.key === p.cat);
    const [lng, lat] = f.geometry.coordinates;
    const depth = onDepthAt ? onDepthAt(lng, lat) : null;
    const risk = depth == null ? '' :
      depth >= 0.30 ? `<div class="ft-pop-risk ft-risk-hi">Access blocked — ${depth.toFixed(2)} m at this location</div>`
      : depth >= 0.05 ? `<div class="ft-pop-risk ft-risk-mid">Water on approach — ${depth.toFixed(2)} m</div>`
      : `<div class="ft-pop-risk ft-risk-ok">Dry at this timestep</div>`;
    new window.maplibregl.Popup({ offset: 12 })
      .setLngLat(f.geometry.coordinates)
      .setHTML(
        `<div class="ft-pop"><b style="color:${cfg?.accent || '#334'}">${p.icon || ''} ${cfg?.label || 'Asset'}</b>` +
        `<div class="ft-pop-name">${p.name}</div>` +
        (p.addr ? `<div>${p.addr}</div>` : '') + risk +
        `</div>`
      )
      .addTo(map);
  };
  const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
  const leave = () => { map.getCanvas().style.cursor = ''; };
  map.on('click', 'assets-cluster', onCluster);
  map.on('click', 'assets-point', onPoint);
  for (const id of ['assets-cluster', 'assets-point']) {
    map.on('mouseenter', id, enter);
    map.on('mouseleave', id, leave);
  }

  let masterOn = false;
  let disposed = false;
  function refresh() {
    const src = map.getSource(SRC);
    if (src) src.setData(masterOn && enabled.size ? fc() : EMPTY);
  }
  function applyVis() {
    const on = masterOn && enabled.size > 0;
    for (const id of LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  // ── Background load ────────────────────────────────────────────────────────
  // Retried, because the upstream this proxies is the one piece of the console
  // nobody here controls. Backoff is generous: the server serves stale-while-
  // revalidate, so a retry that lands mid-rebuild still gets usable data.
  const BACKOFF_MS = [1200, 3500, 9000];
  async function load(attempt = 0) {
    if (disposed) return;
    try {
      const res = await fetch('/api/assets?bbox=' + encodeURIComponent(GURUGRAM_BBOX));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buckets = await res.json();
      if (buckets.error) throw new Error(buckets.error);
      if (disposed) return;

      for (const cfg of CRITICAL_ASSETS) {
        byCat[cfg.key] = (buckets[cfg.key] || [])
          .filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng));
        counts[cfg.key] = byCat[cfg.key].length;
      }
      loadState = 'ready';
      onCounts?.({ ...counts });
      onStatus?.('ready');
      refresh();                    // no-op unless the layer is already switched on
      engine.triggerRepaint();
    } catch (err) {
      if (disposed) return;
      if (attempt < BACKOFF_MS.length) {
        onStatus?.('retrying');
        setTimeout(() => load(attempt + 1), BACKOFF_MS[attempt]);
        return;
      }
      // Out of retries. The layer stays mounted and empty rather than taking the
      // whole feature down — every other switch in the console keeps working.
      loadState = 'failed';
      onStatus?.('failed', String(err.message || err));
      console.warn('[assets] critical assets unavailable:', err);
    }
  }
  load();

  return {
    counts,
    get loadState() { return loadState; },
    get total() { return Object.values(counts).reduce((a, b) => a + b, 0); },
    /** Force another attempt — for a "retry" affordance in the panel. */
    reload() { if (loadState !== 'loading') { loadState = 'loading'; load(); } },
    setVisible(on) { masterOn = on; refresh(); applyVis(); },
    setCategory(key, on) {
      if (on) enabled.add(key); else enabled.delete(key);
      refresh(); applyVis();
    },
    isCategoryOn: (key) => enabled.has(key),
    dispose() {
      disposed = true;
      map.off('click', 'assets-cluster', onCluster);
      map.off('click', 'assets-point', onPoint);
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    },
  };
}
