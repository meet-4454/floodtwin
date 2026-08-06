/* ─────────────────────────────────────────────────────────────────────────────
 * controller.js — the one place React state becomes WebGL state.
 *
 * Every feature is mounted LAZILY the first time it is switched on, and each
 * mount is memoised by a promise so a double-click can never build it twice.
 * That is most of the cold-load win: a first paint costs the map, the manifest
 * and one 768² depth grid — the drainage network, the sewer inventory and the
 * asset index are only fetched if you ask for them.
 *
 * The independence contract from features/registry.js is enforced here: a
 * feature's handler touches only its own handle. Anything global (the x-ray dim,
 * layer stacking) is recomputed from the WHOLE current state in reconcile(),
 * never by one feature writing another's flag.
 * ─────────────────────────────────────────────────────────────────────────── */
import { createEngine, assertOrder } from './core.js';
import { createSimData, DATASETS } from './simData.js';
import { createFloodSurface } from './floodSurface.js';
import { useTwin } from '../store/useTwin.js';
import { FEATURES } from '../features/registry.js';

export async function startTwin({ container }) {
  const S = useTwin.getState;

  // ── EVERYTHING THAT CAN START AT ONCE, STARTS AT ONCE ─────────────────────
  // This chain used to be strictly serial: config → SDK → map → manifest →
  // grid → first paint, so the user waited for five round trips end to end even
  // though only ONE of them actually depends on another. The key is server-side
  // (/api/config) but the flood data does not need it, and the first frame's
  // filename is fixed, so the manifest and grid can be in flight while the
  // Mappls SDK is still downloading.
  S().setStatus('Starting…');
  const cfgP = fetch('/api/config').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const sim = createSimData();
  const manP = sim.loadManifest('event');
  // Warm the first depth grid immediately — same URL regardless of the manifest.
  const warmP = fetch('/sim/surface_grid_00.bin').catch(() => null);

  const cfg = await cfgP;
  S().setStatus('Loading map…');
  const [engine, man] = await Promise.all([
    createEngine({ container, mapplsKey: cfg.mapplsApiKey, onStatus: (m) => S().setStatus(m) }),
    manP,
  ]);
  S().setTimeline(man, 'event');

  S().setStatus('Building flood surface…');
  await warmP;                  // already resolved in practice; keeps the cache hot
  await sim.useFrame(0);
  const flood = createFloodSurface(engine, sim);
  engine.layers.flood = flood;
  S().setMaxDepth(sim.maxDepthScale);
  flood.setOpacity(S().opacity);

  // ── lazy feature mounts ───────────────────────────────────────────────────
  const mounts = new Map();     // id → Promise<handle>
  const handles = engine.layers;

  /* STALE-BUILD RECOVERY.
   *
   * Every feature below is a lazily `import()`ed chunk with a content-hashed
   * filename, served immutable for a year — and `emptyOutDir` deletes the old
   * hashes on every rebuild. So a console left open across a deploy is holding
   * URLs that no longer exist: the page itself keeps working (index.html is
   * no-store, the already-loaded chunks are in memory) right up until you toggle
   * a feature you had not opened yet, and that import 404s. Retrying by toggling
   * again can never fix it — the file is gone from the server.
   *
   * The cure is a reload, which fetches a fresh index.html and its current chunk
   * names. Guarded by a sessionStorage flag so a genuinely broken build cannot
   * put the tab in a reload loop; the second failure surfaces as a normal error. */
  const RELOADED_KEY = 'ft_stale_build_reloaded';
  const isChunkLoadError = (e) => {
    const m = `${e?.message || e}`;
    return /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(m);
  };

  const mount = (id, fn) => {
    if (mounts.has(id)) return mounts.get(id);
    S().setFeatureStatus(id, 'loading');
    const p = Promise.resolve()
      .then(fn)
      .then((h) => {
        handles[id] = h;
        // A chunk loaded cleanly, so this build is coherent — re-arm the
        // one-shot reload for whatever deploy comes next in this tab.
        sessionStorage.removeItem(RELOADED_KEY);
        S().setFeatureStatus(id, 'ready');
        return h;
      })
      .catch((e) => {
        console.warn(`[feature ${id}]`, e);
        if (isChunkLoadError(e) && !sessionStorage.getItem(RELOADED_KEY)) {
          sessionStorage.setItem(RELOADED_KEY, '1');
          S().setStatus('A newer build is live — reloading…');
          window.location.reload();
          return;                  // the page is going away; don't flag an error
        }
        S().setFeatureStatus(id, 'error', e.message || String(e));
        mounts.delete(id);         // let the user retry by toggling again
        throw e;
      });
    mounts.set(id, p);
    return p;
  };

  const builders = {
    flood: async () => flood,

    wards: async () => {
      const { createWards } = await import('./buildings.js');
      return createWards(engine);
    },

    buildings: async () => {
      const { createBuildings } = await import('./buildings.js');
      return createBuildings(engine);
    },

    assets: async () => {
      const { createAssetsLayer } = await import('./assetsLayer.js');
      // Returns as soon as the layers exist; the POIs stream in behind it and
      // push their own counts, so switching this on is never gated on Google.
      const h = await createAssetsLayer(engine, {
        onDepthAt: (lng, lat) => sim.depthAt(lng, lat),
        onCounts: (c) => S().setAssetCounts(c),
      });
      // Apply whichever categories are already ticked in the panel.
      for (const c of FEATURES.find((f) => f.id === 'assets').children) {
        h.setCategory(c.id, !!S().features[`assets.${c.id}`]);
      }
      return h;
    },

    sewer: async () => {
      const { createSewerLayer } = await import('./sewerLayer.js');
      const h = await createSewerLayer(engine);
      S().setSewerStats(h.stats);
      return h;
    },

    roads: async () => {
      const { createRoadsLayer } = await import('./roadsLayer.js');
      return createRoadsLayer(engine, {
        depthAt: (lng, lat) => sim.depthAtSmooth(lng, lat),
        onSegments: (segs) => S().setRoadSegments(segs),
      });
    },

    drainage: async () => {
      S().setStatus('Loading drainage network…');
      const geom = await sim.loadGeometry();
      const [{ createDrainageViz }, { createDrainageAssets }] = await Promise.all([
        import('./drainageViz.js'), import('./drainageAssets.js'),
      ]);
      // No maxDepth: the underground levels itself against the network's own
      // median node depth, not against the surface flood's drifting colour scale.
      const viz = createDrainageViz(engine, geom);
      const assets = await createDrainageAssets(engine, { depthAt: (a, b) => sim.depthAt(a, b) });
      handles.drainAssets = assets;
      S().setDrainStats({
        links: viz.links, chains: viz.chains, tiers: viz.tierCount,
        classes: viz.classCount, ...assets.stats,
      });
      viz.setZoom(engine.map.getZoom());
      const rec = await sim.fetchHour(S().step);
      if (rec) {
        viz.updateHour(rec, geom.nodeMax, sim.state.man.depth_scale, sim.state.man.flow_scale);
        assets.updateFrame(rec, geom);
        S().setSurcharged(assets.surchargedCount);
      }
      return viz;
    },
  };

  /** Reconcile everything that more than one feature can affect. */
  function reconcile() {
    const f = S().features;
    assertOrder(engine, { xray: !!f.xray });
  }

  // ── apply one feature's state ─────────────────────────────────────────────
  async function applyFeature(id, on) {
    switch (id) {
      case 'flood':
        flood.setVisible(on);
        break;

      case 'hotspots':
        // Hotspot beacons are DOM overlays owned by React; the store flag is all
        // the engine needs. Recompute so the list is current when switched on.
        if (on) refreshDerived();
        else S().setHotspots([]);
        break;

      case 'xray':
        reconcile();
        break;

      case 'terrain':
        try {
          engine.map.easeTo({ pitch: on ? 55 : 0, duration: 700 });
        } catch { /* map not ready */ }
        break;

      default: {
        if (!builders[id]) return;
        if (!on && !mounts.has(id)) return;        // never built → nothing to hide
        let h;
        try { h = await mount(id, builders[id]); } catch { return; }
        h.setVisible?.(on);
        if (id === 'drainage') {
          handles.drainAssets?.setVisible(on);
          applyDrainageChildren();
        }
        if (id === 'assets') applyAssetChildren();
        break;
      }
    }
    reconcile();
  }

  function applyDrainageChildren() {
    const viz = handles.drainage, da = handles.drainAssets, f = S().features;
    if (!viz) return;
    const classIdx = { storm: 0, sewer: 1, unclass: 2 };
    for (const [key, i] of Object.entries(classIdx)) viz.setClass(i, !!f[`drainage.${key}`]);
    const tierIdx = { trunk: 0, main: 1, lateral: 2 };
    for (const [key, i] of Object.entries(tierIdx)) {
      const v = f[`drainage.${key}`];
      viz.setTier(i, v === 'auto' ? null : !!v);
    }
    for (const k of ['water', 'shafts']) viz.setLayer(k, !!f[`drainage.${k}`]);
    viz.setMode(f['drainage.capacity'] ? 'capacity' : 'water');
    if (da) for (const k of ['surcharge', 'inlets', 'outfalls', 'pumps']) da.setLayer(k, !!f[`drainage.${k}`]);
  }

  function applyAssetChildren() {
    const h = handles.assets;
    if (!h) return;
    for (const c of FEATURES.find((f) => f.id === 'assets').children) {
      h.setCategory(c.id, !!S().features[`assets.${c.id}`]);
    }
  }

  // ── per-step refresh ──────────────────────────────────────────────────────
  let stepToken = 0;
  async function applyStep(step) {
    const token = ++stepToken;
    await sim.useFrame(step);
    if (token !== stepToken) return;             // a newer scrub superseded this
    flood.refresh();
    // KPI is one pass over the grid (~1 ms) and it is the read-out that tells
    // you the frame actually changed — compute it inline, before anything that
    // can early-return, rather than inside the debounced block below.
    S().setKpi(sim.frameStats());
    const scale = sim.maxDepthScale;
    if (Math.abs(scale - S().maxDepth) > 1e-3) {
      S().setMaxDepth(scale);
      handles.drainage?.setMaxDepth(scale);
      flood.setBands(S().bands, S().bandEdges());
    }
    if (handles.drainage || handles.drainAssets) {
      const rec = await sim.fetchHour(step);
      if (token !== stepToken || !rec) return;
      const geom = sim.state.geom;
      handles.drainage?.updateHour(rec, geom.nodeMax, sim.state.man.depth_scale, sim.state.man.flow_scale);
      if (handles.drainAssets) {
        handles.drainAssets.updateFrame(rec, geom);
        S().setSurcharged(handles.drainAssets.surchargedCount);
      }
    }
    handles.roads?.refresh();
    refreshDerived();
  }

  // Only the hotspot scan is debounced — it re-ranks the whole grid and would
  // otherwise run on every frame of a pan.
  let derivedTimer = null;
  function refreshDerived() {
    clearTimeout(derivedTimer);
    derivedTimer = setTimeout(() => {
      try {
        S().setKpi(sim.frameStats());
        if (!S().features.hotspots) return;
        const b = engine.map.getBounds?.();
        const bounds = b ? { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() } : null;
        S().setHotspots(sim.hotspots({ bounds, limit: 8, minSepDeg: 0.006 }));
      } catch (e) {
        console.warn('[derived read-outs]', e);
      }
    }, 200);
  }

  // ── dataset switch ────────────────────────────────────────────────────────
  let datasetBusy = null;
  async function applyDataset(id) {
    if (id === sim.state.dataset || datasetBusy === id) return;
    datasetBusy = id;
    try {
      S().setStatus(`Loading ${DATASETS[id]?.label || id}…`);
      const m = await sim.loadManifest(id);
      S().setTimeline(m, id);
      const step = Math.min(S().step, Math.max(0, m.n_hours - 1));
      useTwin.setState({ step });
      await applyStep(step);
      S().setStatus('Ready');
    } catch (e) {
      console.warn('[dataset]', e);
      S().setStatus(`Could not load ${DATASETS[id]?.label || id}`);
    } finally {
      datasetBusy = null;
    }
  }

  // ── wire the store ────────────────────────────────────────────────────────
  //
  // RE-ENTRANCY: every handler below may itself write to the store (a status
  // message, a stat, a derived read-out), which re-enters this subscriber
  // synchronously. So the `prev` snapshot is advanced BEFORE any handler runs —
  // otherwise a handler that writes on its first line sees the same diff again
  // and calls itself forever. That is exactly what applyDataset did: its opening
  // setStatus() re-triggered "dataset changed" and blew the stack.
  let prev = S();
  const unsub = useTwin.subscribe((s) => {
    const was = prev;
    prev = s;

    if (s.features !== was.features) {
      for (const key of Object.keys(s.features)) {
        if (s.features[key] === was.features[key]) continue;
        if (key.includes('.')) {
          const [parent] = key.split('.');
          if (parent === 'drainage') applyDrainageChildren();
          else if (parent === 'assets') applyAssetChildren();
        } else {
          applyFeature(key, s.features[key]);
        }
      }
    }
    if (s.dataset !== was.dataset) applyDataset(s.dataset);
    else if (s.step !== was.step) applyStep(s.step);   // the dataset path re-steps itself
    if (s.opacity !== was.opacity) flood.setOpacity(s.opacity);
    if (s.bands !== was.bands || s.maxDepth !== was.maxDepth) flood.setBands(s.bands, S().bandEdges());
  });

  // zoom drives the pipe-tier LOD and re-ranks the visible hotspots
  // `zoom` fires many times per gesture; both handlers below rebuild uniforms,
  // so coalesce to one apply per animation frame.
  let zoomRaf = null;
  const onZoom = () => {
    if (zoomRaf) return;
    zoomRaf = requestAnimationFrame(() => {
      zoomRaf = null;
      const z = engine.map.getZoom();
      handles.drainage?.setZoom(z);
      flood.setZoom(z);          // wider depth blur when pulled back
    });
  };
  engine.map.on('zoom', onZoom);
  engine.map.on('moveend', refreshDerived);

  // Tap the water → depth readout + a splash ring.
  engine.map.on('click', (e) => {
    const { lng, lat } = e.lngLat;
    const d = sim.depthAt(lng, lat);
    if (d > 0.02) flood.ripple(lng, lat);
    window.dispatchEvent(new CustomEvent('ft:probe', {
      detail: { lng, lat, depth: d, point: e.point },
    }));
  });

  // Debug: ?bare=N mounts only the first N default-on features, so a rendering
  // regression can be bisected against the feature list in one reload.
  const bare = new URLSearchParams(location.search).get('bare');
  const limit = bare === null ? Infinity : Number(bare);
  const initial = S().features;
  let mounted = 0;
  const boot = [];
  for (const f of FEATURES) {
    if (!initial[f.id]) continue;
    if (mounted >= limit) { console.log('[bare] skipping', f.id); continue; }
    mounted++;
    // Independent by contract (see registry.js), so they mount concurrently —
    // serially awaiting each one stacked a dynamic import plus a fetch per
    // feature onto the critical path for no reason.
    boot.push(applyFeature(f.id, true));
  }
  await Promise.all(boot);
  flood.setBands(S().bands, S().bandEdges());
  flood.setZoom(engine.map.getZoom());
  await applyStep(0);
  reconcile();

  S().setPhase('ready');
  S().setStatus('Ready');

  // Debug handle for headless verification (the map alone can't tell you which
  // frame is bound or what the derived read-outs think).
  window.__ftTwin = { engine, sim, handles, applyStep, refreshDerived, store: useTwin };

  return {
    engine, sim, handles,
    jumpToDeepest() {
      const p = sim.deepestPoint();
      if (!p) return null;
      engine.map.flyTo({ center: [p.lng, p.lat], zoom: 17, pitch: 55, duration: 1500 });
      return p;
    },
    flyTo(lng, lat, zoom = 16) {
      engine.map.flyTo({ center: [lng, lat], zoom, duration: 1200 });
    },
    depthAt: (lng, lat) => sim.depthAt(lng, lat),
    destroy() {
      unsub();
      engine.map.off('zoom', onZoom);
      engine.map.off('moveend', refreshDerived);
      for (const h of Object.values(handles)) h?.dispose?.();
      engine.destroy();
    },
  };
}
