/* ─────────────────────────────────────────────────────────────────────────────
 * drainageAssets.js — the real MCG/GMDA point assets on the drainage network,
 * plus the solved surcharge markers.
 *
 * All four datasets are recorded inventories shipped with the model run:
 *   inlets_rim.geojson          5,922 side-entry pits with rim levels
 *   outfalls.geojson            network discharge points
 *   pumps.geojson               50 MCG pumps with activation/stop depths
 *   manholes_progression.geojson  152 manholes with observed surcharge onset
 *
 * Surcharging nodes are NOT an inventory — they come from the coupled run's own
 * per-frame surcharge bitmask, so the count matches the model's hourly summary
 * exactly. They are drawn as one Points cloud with a compacted draw range: at
 * peak, 12,559 nodes surcharge at once and anything per-marker would stall.
 *
 * RETURNS SYNCHRONOUSLY. This used to `await` three GeoJSON fetches before the
 * caller got anything back, which put ~135 KB of pit/pump inventory on the
 * critical path of the 3-D drainage mount — 139,798 conduits waited on a pump
 * marker. The handle now comes back immediately with the surcharge cloud live,
 * and the point layers add themselves when their data lands; `onReady` fires
 * then, carrying the counts.
 * ─────────────────────────────────────────────────────────────────────────── */
import { addLayerSafe, FONT_BOLD } from './core.js';

export function createDrainageAssets(engine, { depthAt, onReady } = {}) {
  const { map, THREE, scene, toLocal } = engine;
  // A missing inventory must degrade the map, never break the drainage mount.
  const noFail = (url) => engine.client.jsonOrNull(url);

  const groups = {};   // name → [layer ids]
  const on = { inlets: true, outfalls: true, pumps: true, surcharge: true };
  let master = false;
  let pumps = null;
  const stats = { inlets: 0, outfalls: 0, pumps: 0 };

  const addSrc = (id, data) => { if (data && !map.getSource(id)) map.addSource(id, { type: 'geojson', data }); };

function addInlets(inlets) {
  // ── Inlets / gullies: only meaningful once you are in a street, so minzoom.
  if (inlets) {
    addSrc('inlets-src', inlets);
    if (!map.getLayer('inlets-grates')) {
      addLayerSafe(map, {
        id: 'inlets-grates', type: 'circle', source: 'inlets-src', minzoom: 14.5,
        layout: { visibility: 'none' },
        paint: {
          // Small dark SQUARES, not dots — a gully grate, and unmistakably not a
          // critical-asset pin.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.5, 2.0, 18, 4],
          'circle-color': '#1f4a63',
          'circle-stroke-width': 1, 'circle-stroke-color': '#cfe9f5', 'circle-opacity': 0.95,
        },
      });
    }
    groups.inlets = ['inlets-grates'];
  }
}

function addOutfalls(outfalls) {
  // ── Outfalls: a teal down-triangle, fixed screen size, distinct from pumps.
  if (outfalls) {
    addSrc('outfalls-src', outfalls);
    if (!map.getLayer('outfalls-circles')) {
      addLayerSafe(map, {
        id: 'outfalls-circles', type: 'circle', source: 'outfalls-src', minzoom: 10,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 8, 'circle-color': '#0f766e', 'circle-opacity': 0.95,
          'circle-stroke-width': 2, 'circle-stroke-color': '#d7f5ef',
        },
      });
      addLayerSafe(map, {
        id: 'outfalls-glyph', type: 'symbol', source: 'outfalls-src', minzoom: 10,
        layout: { visibility: 'none', 'text-field': '▼', 'text-size': 11,
                 'text-allow-overlap': true, 'text-font': FONT_BOLD },
        paint: { 'text-color': '#ffffff' },
      });
    }
    groups.outfalls = ['outfalls-circles', 'outfalls-glyph'];
  }
}

function addPumps(pumpData) {
  // ── Pumps: green idle / blue running. "Running" is decided by the SOLVED
  // water depth at the pump against its own recorded activation depth.
  pumps = pumpData;
  if (pumps) {
    addSrc('pumps-src', pumps);
    if (!map.getLayer('pumps-circles')) {
      addLayerSafe(map, {
        id: 'pumps-circles', type: 'circle', source: 'pumps-src', minzoom: 10,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 8,
          'circle-color': ['case', ['boolean', ['feature-state', 'running'], false], '#b45309', '#57534e'],
          'circle-opacity': 0.95,
          'circle-stroke-width': 2, 'circle-stroke-color': '#f5ead7',
        },
      });
      addLayerSafe(map, {
        id: 'pumps-labels', type: 'symbol', source: 'pumps-src', minzoom: 10,
        layout: { visibility: 'none', 'text-field': '■', 'text-size': 10, 'minzoom': 10,
                 'text-allow-overlap': true, 'text-font': FONT_BOLD },
        paint: { 'text-color': '#ffffff' },
      });
    }
    groups.pumps = ['pumps-circles', 'pumps-labels'];
    // feature-state needs stable ids
    (pumps.features || []).forEach((f, i) => { f.id = i; });
    map.getSource('pumps-src')?.setData(pumps);
  }
}

  // ── Surcharging nodes (solved, per frame).
  let surchMesh = null, surchGeo = null, surchCount = 0;
  function ensureSurcharge(nNodes) {
    if (surchMesh || !scene) return;
    surchGeo = new THREE.BufferGeometry();
    surchGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nNodes * 3), 3));
    surchGeo.setDrawRange(0, 0);
    surchMesh = new THREE.Points(surchGeo, new THREE.PointsMaterial({
      color: 0xff5a3c, size: 7, sizeAttenuation: false,
      transparent: true, opacity: 0.55, depthWrite: false,
    }));
    surchMesh.frustumCulled = false;
    surchMesh.renderOrder = 5;
    surchMesh.visible = false;
    scene.add(surchMesh);
  }

  function applyVis() {
    for (const [name, ids] of Object.entries(groups)) {
      const vis = master && on[name] ? 'visible' : 'none';
      for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
    if (surchMesh) surchMesh.visible = master && on.surcharge;
    engine.triggerRepaint();
  }

  const popup = (e, html) => new window.maplibregl.Popup({ offset: 10 })
    .setLngLat(e.lngLat).setHTML(html).addTo(map);

  // Registered up front rather than gated on `groups.*`: the layers they target
  // are added asynchronously now, and MapLibre happily holds a handler for a
  // layer id that does not exist yet.
  {
    map.on('click', 'pumps-circles', (e) => {
      const p = e.features[0].properties || {};
      const d = depthAt ? depthAt(e.lngLat.lng, e.lngLat.lat) : null;
      popup(e, `<div class="ft-pop"><b style="color:#1d8fff">Storm pump</b>` +
        `<div class="ft-pop-name">${p.name || p.pump_id || 'MCG pump'}</div>` +
        (p.capacity_m3s ? `<div>capacity ${p.capacity_m3s} m³/s</div>` : '') +
        (p.activation_depth_m ? `<div>activates at ${p.activation_depth_m} m</div>` : '') +
        (d != null ? `<div>water here now: <b>${d.toFixed(2)} m</b></div>` : '') +
        `<div class="ft-pop-src">MCG recorded asset</div></div>`);
    });
  }
  {
    map.on('click', 'outfalls-circles', (e) => {
      const p = e.features[0].properties || {};
      popup(e, `<div class="ft-pop"><b style="color:#12b39a">Outfall</b>` +
        `<div class="ft-pop-name">${p.name || p.outfall_id || 'Network discharge point'}</div>` +
        `<div class="ft-pop-src">Network discharge — recorded asset</div></div>`);
    });
  }

  // ── Background load ───────────────────────────────────────────────────────
  // Off the critical path entirely: the surcharge cloud is already live, and the
  // recorded point inventories drop in when they arrive.
  let disposed = false;
  Promise.all([
    noFail('/drainage/inlets_rim.geojson'),
    noFail('/drainage/outfalls.geojson'),
    noFail('/drainage/pumps.geojson'),
  ]).then(([inlets, outfalls, pumpData]) => {
    if (disposed) return;
    addInlets(inlets);
    addOutfalls(outfalls);
    addPumps(pumpData);
    stats.inlets = inlets?.features?.length || 0;
    stats.outfalls = outfalls?.features?.length || 0;
    stats.pumps = pumpData?.features?.length || 0;
    applyVis();
    onReady?.(handle);
  }).catch((e) => console.warn('[drainage assets]', e));

  const handle = {
    stats,
    get surchargedCount() { return surchCount; },
    setVisible(v) { master = v; applyVis(); },
    setLayer(name, v) { if (name in on) { on[name] = v; applyVis(); } },

    /** Repaint from a solved frame: surcharge pins + pump running state. */
    updateFrame(rec, geom) {
      if (!rec || !geom) return;
      ensureSurcharge(geom.nodeLon.length);
      const sur = rec.sur, nn = geom.nodeLon.length;
      const arr = surchGeo.attributes.position.array;
      let n = 0;
      for (let i = 0; i < nn; i++) {
        if (sur[i >> 3] & (1 << (i & 7))) {
          const p = toLocal(geom.nodeLon[i], geom.nodeLat[i]);
          arr[n * 3] = p.x; arr[n * 3 + 1] = 0.6; arr[n * 3 + 2] = p.z;
          n++;
        }
      }
      surchGeo.attributes.position.needsUpdate = true;
      surchGeo.setDrawRange(0, n);
      surchCount = n;
      if (surchMesh) surchMesh.visible = master && on.surcharge;

      if (pumps && depthAt) {
        (pumps.features || []).forEach((f, i) => {
          const c = f.geometry?.coordinates;
          if (!c) return;
          const act = +(f.properties?.activation_depth_m ?? 0.15);
          map.setFeatureState({ source: 'pumps-src', id: i }, { running: depthAt(c[0], c[1]) >= act });
        });
      }
      engine.triggerRepaint();
    },

    dispose() {
      disposed = true;
      for (const ids of Object.values(groups)) for (const id of ids) if (map.getLayer(id)) map.removeLayer(id);
      for (const s of ['inlets-src', 'outfalls-src', 'pumps-src']) if (map.getSource(s)) map.removeSource(s);
      if (surchMesh) { scene.remove(surchMesh); surchGeo.dispose(); surchMesh.material.dispose(); }
    },
  };
  return handle;
}
