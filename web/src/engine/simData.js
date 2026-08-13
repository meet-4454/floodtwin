/* ─────────────────────────────────────────────────────────────────────────────
 * simData.js — the data spine. Everything the app shows comes from here.
 *
 * PROVENANCE (no synthetic sources):
 *   /sim   — `full_12h_run`: fused CUDA full shallow-water + Horton infiltration
 *            forced by the REPORTED 09-Jul-2025 Gurugram rainfall (133 mm/12 h),
 *            with outfall tailwater priors and surface recharge in the physics.
 *            981,880 surface triangles, 118,768 drainage nodes, 139,798 links,
 *            13 hourly snapshots, mass residual 0.22 %.
 *   /live  — the MCG partner's daily coupled 2D+1D forecast, 145 frames at 10
 *            min. It indexes the SAME node/link ids, so geometry is shared and
 *            only the dynamics are re-fetched when you switch dataset.
 *
 * Both are transcoded to compact binaries (u16 mm depth, int16 flow×100,
 * surcharge bitmask, 768² depth grid) — 1149 MB of GeoJSON became ~15 MB gzipped.
 * ─────────────────────────────────────────────────────────────────────────── */

export const DATASETS = {
  event: {
    id: 'event', base: '/sim', label: '09 Jul 2025 Event',
    blurb: 'Reconstruction of the reported 133 mm / 12 h storm — hourly.',
  },
  live: {
    id: 'live', base: '/live', label: 'Live Forecast',
    blurb: "MCG partner's daily coupled run — 10-minute frames, ~24 h ahead.",
  },
};

// build_live_forecast.py / build_sim_binaries.py name frames with Python's
// `{i:02d}` — that is a MINIMUM width, not a fixed one, so frame 7 is "07" and
// frame 144 is "144". Padding the 145-frame forecast to three digits requested
// `surface_grid_000.bin`, which does not exist: the live dataset 404'd on every
// frame below 100.
const pad = (n) => String(n).padStart(2, '0');

/* ── VERSIONED DATA URLS ──────────────────────────────────────────────────────
 *
 * Every dataset file is asked for as `<name>.bin?v=<manifest version>`, and the
 * server freezes anything carrying a `?v=` for a year (routes/data.py,
 * http.cache). Two problems go away at once.
 *
 * SPEED. These files were revalidated — `no-cache` — so a browser holding the
 * whole forecast in its cache still had to ASK about every frame before drawing
 * it. Playing 145 frames meant ~290 conditional GETs, all answered 304, and on a
 * municipal link that round trip per frame IS the stutter. A version in the url
 * makes a second playthrough entirely local.
 *
 * CORRECTNESS. The partner's run is rebuilt daily into the same filenames, so
 * `surface_grid_07.bin` means something different tomorrow. Revalidation catches
 * that only as long as every cache in the path honours no-cache. With the run
 * baked into the url there is nothing to honour: a new run is new urls, and the
 * old bytes are unreachable rather than merely suspect.
 *
 * The manifest itself is never versioned — it is what CARRIES the version, and
 * it stays revalidated so a new run is always seen. */
const withV = (url, v) => (v ? `${url}?v=${encodeURIComponent(v)}` : url);

/**
 * @param {object} client  The instance's HTTP client (lib/client.js). Every
 *   dataset path below is relative to its base URL, so the same code serves our
 *   own console (base '') and a partner's proxy ('/api/floodtwin'). The `?v=`
 *   versioning above composes with it — the client only prefixes the base.
 */
export function createSimData(client) {
  const state = {
    dataset: 'event',
    base: '/sim',
    man: null,
    /** frame index → Float32Array(grid_n²) of metres */
    gridCache: new Map(),
    /** frame index → { depth, sur, flow } */
    hourCache: new Map(),
    /** frame index → in-flight promise. Without these, concurrent callers all
     *  miss the cache and each fires its own request — a scrub across the
     *  timeline turned into a request storm for the same few frames. */
    gridInflight: new Map(),
    hourInflight: new Map(),
    grid: null,            // the live Float32Array bound to the flood texture
    gridFrame: -1,
    maxObserved: 0,
    geom: null,            // { nodeLon, nodeLat, nodeInv, nodeMax, nodeArea, linkFrom, linkTo, linkPeak }
  };

  async function loadManifest(datasetId) {
    const ds = DATASETS[datasetId] || DATASETS.event;
    const res = await client.raw(`${ds.base}/manifest.json`);
    if (!res.ok) throw new Error(`${ds.label} dataset is not built (${ds.base}/manifest.json → ${res.status})`);
    const man = await res.json();
    state.dataset = ds.id;
    state.base = ds.base;
    state.man = man;
    state.gridCache.clear();
    state.hourCache.clear();
    state.gridInflight.clear();
    state.hourInflight.clear();
    state.gridFrame = -1;
    // Forecast manifests carry per-frame max_depth_m, so the colour scale is
    // known up front; the event dataset has none and grows into what it sees.
    state.maxObserved = 0;
    if (Array.isArray(man.frames)) {
      for (const f of man.frames) if (f?.max_depth_m > state.maxObserved) state.maxObserved = f.max_depth_m;
    }
    return man;
  }


  function fetchGrid(i) {
    if (state.gridCache.has(i)) return Promise.resolve(state.gridCache.get(i));
    const flying = state.gridInflight.get(i);
    if (flying) return flying;
    const url = withV(`${state.base}/surface_grid_${pad(i)}.bin`, state.man?.version);
    const p = client.raw(url)
      .then((r) => { if (!r.ok) throw new Error(`grid ${i}`); return r.arrayBuffer(); })
      .then((buf) => {
        const u16 = new Uint16Array(buf);
        state.gridCache.set(i, u16);
        if (state.gridCache.size > 8) state.gridCache.delete(state.gridCache.keys().next().value);
        return u16;
      })
      .finally(() => state.gridInflight.delete(i));
    state.gridInflight.set(i, p);
    return p;
  }

  /** Decode frame `i` into state.grid (metres). Returns the frame's max depth. */
  async function useFrame(i) {
    const man = state.man;
    if (!man) return 0;
    const f = Math.max(0, Math.min(i, man.n_hours - 1));
    const u16 = await fetchGrid(f);
    const n = man.grid_n;
    if (!state.grid || state.grid.length !== n * n) state.grid = new Float32Array(n * n);
    const g = state.grid, ds = man.depth_scale || 1000;
    let mx = 0;
    for (let k = 0; k < g.length; k++) { const v = u16[k] / ds; g[k] = v; if (v > mx) mx = v; }
    state.gridFrame = f;
    if (mx > state.maxObserved) state.maxObserved = mx;
    if (f + 1 < man.n_hours) fetchGrid(f + 1).catch(() => {});   // prefetch
    return mx;
  }

  /** O(1) depth at a point — the one depth query the whole app uses. */
  function depthAt(lng, lat) {
    const man = state.man;
    if (!state.grid || !man?.grid_bbox) return 0;
    const bb = man.grid_bbox, N = man.grid_n;
    if (lng < bb[0] || lng > bb[2] || lat < bb[1] || lat > bb[3]) return 0;
    const x = Math.min(N - 1, Math.max(0, Math.round(((lng - bb[0]) / (bb[2] - bb[0])) * (N - 1))));
    const y = Math.min(N - 1, Math.max(0, Math.round(((lat - bb[1]) / (bb[3] - bb[1])) * (N - 1))));
    return state.grid[y * N + x];
  }

  /** Bilinear sample — smoother than depthAt for road profiles. */
  function depthAtSmooth(lng, lat) {
    const man = state.man;
    if (!state.grid || !man?.grid_bbox) return 0;
    const bb = man.grid_bbox, N = man.grid_n;
    if (lng < bb[0] || lng > bb[2] || lat < bb[1] || lat > bb[3]) return 0;
    const fx = ((lng - bb[0]) / (bb[2] - bb[0])) * (N - 1);
    const fy = ((lat - bb[1]) / (bb[3] - bb[1])) * (N - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(N - 1, x0 + 1), y1 = Math.min(N - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0, g = state.grid;
    const a = g[y0 * N + x0], b = g[y0 * N + x1], c = g[y1 * N + x0], d = g[y1 * N + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  function fetchHour(i) {
    const man = state.man;
    if (!man) return Promise.resolve(null);
    if (state.hourCache.has(i)) return Promise.resolve(state.hourCache.get(i));
    const flying = state.hourInflight.get(i);
    if (flying) return flying;
    const nn = man.n_nodes, nl = man.n_links, maskB = (nn + 7) >> 3;
    const url = withV(`${state.base}/drain_dyn_${pad(i)}.bin`, man.version);
    const p = client.raw(url)
      .then((r) => { if (!r.ok) throw new Error(`dyn ${i}`); return r.arrayBuffer(); })
      .then((buf) => {
        const rec = {
          depth: new Uint16Array(buf, 0, nn),               // mm
          sur: new Uint8Array(buf, nn * 2, maskB),          // surcharge bitmask
          flow: new Int16Array(buf, nn * 2 + maskB, nl),    // m³/s × flow_scale
        };
        state.hourCache.set(i, rec);
        if (state.hourCache.size > 6) state.hourCache.delete(state.hourCache.keys().next().value);
        return rec;
      })
      .finally(() => state.hourInflight.delete(i));
    state.hourInflight.set(i, p);
    return p;
  }

  /**
   * Network geometry. Always from /sim — the live forecast indexes the same
   * network, so switching dataset never re-downloads or rebuilds it.
   */
  async function loadGeometry() {
    if (state.geom) return state.geom;
    const man = state.man;
    // drain_*_class.bin marks each conduit STORM / SEWER / unclassified. The run
    // itself carries no such field — it solves one undifferentiated network —
    // but that network IS the MCG storm+sewer inventory (91.9 % of sewer chain
    // endpoints sit on a solved node, median 0.21 m), so build_link_classes.py
    // recovers the split by matching endpoint pairs. Optional: if the file is
    // missing everything renders as unclassified rather than failing.
    // The geometry lives in /sim whichever dataset is loaded, so it is stamped
    // with /sim's version — which the live manifest publishes as static_version
    // precisely so this does not have to fetch a second manifest to find it.
    const sv = man?.static_version || man?.version;
    const geomUrl = (name) => withV(`/sim/${name}.bin`, sv);
    const [geo, nstat, lstat, lclass, nclass] = await Promise.all([
      client.buffer(geomUrl('drain_geom')),
      client.buffer(geomUrl('drain_node_static')),
      client.buffer(geomUrl('drain_link_static')),
      client.bufferOrNull(geomUrl('drain_link_class')),
      client.bufferOrNull(geomUrl('drain_node_class')),
    ]);
    const nn = man.n_nodes, nl = man.n_links;
    const ll = new Float32Array(geo, 0, nn * 2);
    const li = new Uint32Array(geo, nn * 8, nl * 2);
    const st = new Float32Array(nstat);
    const g = {
      nodeLon: new Float32Array(nn), nodeLat: new Float32Array(nn),
      nodeInv: new Float32Array(nn), nodeMax: new Float32Array(nn), nodeArea: new Float32Array(nn),
      linkFrom: new Uint32Array(nl), linkTo: new Uint32Array(nl),
      linkPeak: new Float32Array(lstat),
      // 0 = storm, 1 = sewer, 2 = unclassified
      linkClass: lclass ? new Uint8Array(lclass) : new Uint8Array(nl).fill(2),
      nodeClass: nclass ? new Uint8Array(nclass) : new Uint8Array(nn).fill(2),
    };
    for (let i = 0; i < nn; i++) {
      g.nodeLon[i] = ll[i * 2]; g.nodeLat[i] = ll[i * 2 + 1];
      g.nodeInv[i] = st[i * 3]; g.nodeMax[i] = st[i * 3 + 1]; g.nodeArea[i] = st[i * 3 + 2];
    }
    for (let i = 0; i < nl; i++) { g.linkFrom[i] = li[i * 2]; g.linkTo[i] = li[i * 2 + 1]; }
    state.geom = g;
    return g;
  }

  /**
   * Flood hotspots straight off the depth grid.
   *
   * This used to walk 100k+ flood polygons decoded from a 27 MB coordinates.bin.
   * The grid is the same field at 33 m resolution and is already in memory, so
   * the download is gone and the scan is ~40× cheaper. `bounds` restricts to the
   * viewport; omit it for the citywide beacons.
   */
  function hotspots({ cellDeg = 0.006, minDepth = 0.05, limit = 8, bounds = null, minSepDeg = 0, rank = 'extent' } = {}) {
    const man = state.man;
    if (!state.grid || !man?.grid_bbox) return [];
    const bb = man.grid_bbox, N = man.grid_n, g = state.grid;
    const dLng = (bb[2] - bb[0]) / (N - 1), dLat = (bb[3] - bb[1]) / (N - 1);
    const cells = new Map();
    for (let y = 0; y < N; y++) {
      const lat = bb[1] + y * dLat;
      if (bounds && (lat < bounds.s || lat > bounds.n)) continue;
      for (let x = 0; x < N; x++) {
        const d = g[y * N + x];
        if (!(d >= minDepth)) continue;
        const lng = bb[0] + x * dLng;
        if (bounds && (lng < bounds.w || lng > bounds.e)) continue;
        const key = Math.round(lat / cellDeg) * 100000 + Math.round(lng / cellDeg);
        let c = cells.get(key);
        if (!c) { c = { n: 0, sLat: 0, sLng: 0, sD: 0, mx: 0 }; cells.set(key, c); }
        c.n++; c.sLat += lat; c.sLng += lng; c.sD += d;
        if (d > c.mx) c.mx = d;
      }
    }
    const spots = [];
    cells.forEach((c) => spots.push({
      lat: c.sLat / c.n, lng: c.sLng / c.n, avg: c.sD / c.n, max: c.mx, count: c.n,
    }));
    if (rank === 'deepest') spots.sort((a, b) => b.max - a.max);
    else spots.sort((a, b) => b.avg * b.count - a.avg * a.count);
    if (!minSepDeg) return spots.slice(0, limit);
    // greedy min-separation → N DISTINCT hotspots, not N markers in one pool
    const picked = [];
    for (const s of spots) {
      if (picked.every((p) => (p.lat - s.lat) ** 2 + (p.lng - s.lng) ** 2 > minSepDeg * minSepDeg)) {
        picked.push(s);
        if (picked.length >= limit) break;
      }
    }
    return picked;
  }

  /** Deepest single grid cell in the current frame. */
  function deepestPoint() {
    const man = state.man;
    if (!state.grid || !man?.grid_bbox) return null;
    const bb = man.grid_bbox, N = man.grid_n, g = state.grid;
    let mx = 0, mi = -1;
    for (let i = 0; i < g.length; i++) if (g[i] > mx) { mx = g[i]; mi = i; }
    if (mi < 0) return null;
    const y = Math.floor(mi / N), x = mi % N;
    return {
      lng: bb[0] + (x / (N - 1)) * (bb[2] - bb[0]),
      lat: bb[1] + (y / (N - 1)) * (bb[3] - bb[1]),
      depth: mx,
    };
  }

  /** Wet area and flooded fraction for the current frame — the KPI strip. */
  function frameStats() {
    const man = state.man;
    if (!state.grid || !man) return null;
    const g = state.grid;
    const bb = man.grid_bbox, N = man.grid_n;
    // metres per cell at this latitude
    const midLat = (bb[1] + bb[3]) / 2;
    const cw = ((bb[2] - bb[0]) / (N - 1)) * 111320 * Math.cos((midLat * Math.PI) / 180);
    const ch = ((bb[3] - bb[1]) / (N - 1)) * 110540;
    const cellKm2 = (cw * ch) / 1e6;
    let wet = 0, deep = 0, sum = 0, mx = 0;
    for (let i = 0; i < g.length; i++) {
      const d = g[i];
      if (d >= 0.05) { wet++; sum += d; if (d >= 0.3) deep++; }
      if (d > mx) mx = d;
    }
    return {
      wetKm2: wet * cellKm2,
      impassableKm2: deep * cellKm2,
      meanDepth: wet ? sum / wet : 0,
      maxDepth: mx,
    };
  }

  return {
    state,
    loadManifest, useFrame, depthAt, depthAtSmooth, fetchHour, loadGeometry,
    hotspots, deepestPoint, frameStats,
    get maxDepthScale() { return Math.max(0.25, Math.ceil((state.maxObserved || 1) * 10) / 10); },
  };
}
