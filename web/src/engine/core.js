/* ─────────────────────────────────────────────────────────────────────────────
 * core.js — the imperative rendering engine the React shell mounts and drives.
 *
 * React never touches WebGL. It calls createEngine() once, then talks to the
 * returned handle through small verbs (setFeature, setStep, setOpacity…). Every
 * feature module registers itself here and gets: the Mappls map, one shared
 * three.js scene living in a single custom layer, a lng/lat→scene-metres
 * transform, and a repaint hook.
 * ─────────────────────────────────────────────────────────────────────────── */
import * as THREE from 'three';

export const REF_LAT = 28.4595, REF_LNG = 77.0266;
const MAPPLS_SDK = (key) =>
  `https://apis.mappls.com/advancedmaps/api/${encodeURIComponent(key)}/map_sdk?v=3.0&layer=vector`;

/** True once the SDK has finished defining the constructor we need. */
const sdkReady = () => !!(window.mappls && typeof window.mappls.Map === 'function');

/** Poll for `mappls.Map` after the script has executed, up to `budgetMs`. */
function awaitSdkSymbol(budgetMs = 10000) {
  return new Promise((resolve, reject) => {
    if (sdkReady()) return resolve();
    // 25 ms, not 100: the gap between the script executing and the constructor
    // existing is a couple of frames, and a 100 ms tick spent most of that gap
    // asleep — up to a tenth of a second of dead time on every console entry,
    // for nothing.
    const START = Date.now();
    const iv = setInterval(() => {
      if (sdkReady()) { clearInterval(iv); resolve(); }
      else if (Date.now() - START > budgetMs) {
        clearInterval(iv);
        reject(new Error('Mappls SDK loaded but never exposed mappls.Map'));
      }
    }, 25);
  });
}

/* Load the Mappls SDK once per page, retrying a transient CDN/DNS blip.
 *
 * MEMOISED, and it ADOPTS a tag the document already has. Both matter:
 *
 *  • The console can mount more than once in a page's life (StrictMode's dev
 *    double-mount, Overview → console → Overview → console). Each mount called
 *    this, and each call appended ANOTHER <script> for the same SDK, because the
 *    only guard was `window.mappls` — which is still undefined while the first
 *    copy is in flight. Two mounts, two full downloads of the same file, racing.
 *
 *  • On /twin the server now writes the tag into the document head so the
 *    download starts at parse time, in parallel with the React bundle instead of
 *    a round trip behind it (see routes/pages.py). By the time this runs the tag
 *    is usually already there and often already executed, so the right move is to
 *    wait on it, not to request the same bytes a second time. */
let sdkPromise = null;

function loadMapplsSDK(key, onStatus) {
  if (sdkReady()) return Promise.resolve();
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    // The tag the server injected on /twin, if this is a fresh console load.
    const preloaded = document.getElementById('ft-mappls-sdk');
    if (preloaded) {
      awaitSdkSymbol(15000).then(resolve, () => {
        // It is in the document but never produced a usable SDK — a blocked
        // request, most often. Fall through to our own retrying loader.
        preloaded.remove();
        injectWithRetry();
      });
      return;
    }
    injectWithRetry();

    function injectWithRetry() {
      if (!key) {
        reject(new Error('Mappls API key not configured on the server (MAPPLS_API_KEY).'));
        return;
      }
      let attempt = 0;
      const MAX = 3;
      const tryLoad = () => {
        attempt++;
        const s = document.createElement('script');
        s.src = MAPPLS_SDK(key);
        s.async = true;
        // The script tag resolves before `mappls.Map` is actually defined.
        s.onload = () => awaitSdkSymbol().then(resolve, reject);
        s.onerror = () => {
          s.remove();
          if (attempt < MAX) {
            onStatus?.(`Map SDK unreachable — retrying (${attempt}/${MAX - 1})…`);
            setTimeout(tryLoad, 1500 * attempt);
          } else {
            reject(new Error('Map SDK failed to load. Check network / adblock / API key.'));
          }
        };
        document.head.appendChild(s);
      };
      tryLoad();
    }
  }).catch((e) => {
    // Never leave a rejected promise memoised: the retry the user is offered
    // would resolve to the same failure without touching the network.
    sdkPromise = null;
    throw e;
  });
  return sdkPromise;
}

// The Mappls glyph CDN serves only SINGLE-font stacks. MapLibre's default is the
// composite "Open Sans Regular,Arial Unicode MS Regular", which 403s — and a
// symbol layer whose glyphs fail to load renders NO TEXT AT ALL, silently. That
// cost us every cluster count, ward label and marker glyph.
//
// Rather than rely on every call site remembering `text-font`, wrap addLayer once
// and fill it in. Layers that set their own font are left alone.
export const FONT_REGULAR = ['Open Sans Regular'];
export const FONT_BOLD = ['Open Sans Bold'];

/**
 * Add a layer, filling in `text-font` for symbol layers that forgot it.
 *
 * Use this instead of map.addLayer() for anything with a text-field. It is a
 * plain helper, NOT a monkey-patch of map.addLayer: wrapping the SDK's own
 * method blew the stack, because the Mappls wrapper re-enters `this.addLayer`
 * internally and the wrapper then called itself forever.
 */
export function addLayerSafe(map, layer, before) {
  if (layer?.type === 'symbol') {
    const layout = layer.layout || (layer.layout = {});
    if (layout['text-field'] && !layout['text-font']) layout['text-font'] = FONT_REGULAR;
  }
  return map.addLayer(layer, before);
}

function buildTransform() {
  const MC = window.maplibregl?.MercatorCoordinate;
  if (MC) {
    const c = MC.fromLngLat([REF_LNG, REF_LAT], 0);
    return {
      translateX: c.x, translateY: c.y, translateZ: c.z,
      rotateX: Math.PI / 2, rotateY: 0, rotateZ: 0,
      scale: c.meterInMercatorCoordinateUnits(),
    };
  }
  const x = (REF_LNG + 180) / 360;
  const sl = Math.sin((REF_LAT * Math.PI) / 180);
  return {
    translateX: x,
    translateY: 0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI),
    translateZ: 0,
    rotateX: Math.PI / 2, rotateY: 0, rotateZ: 0,
    scale: 1 / (2 * Math.PI * 6378137 * Math.cos((REF_LAT * Math.PI) / 180)),
  };
}

function merc(lng, lat) {
  const MC = window.maplibregl?.MercatorCoordinate;
  if (MC) return MC.fromLngLat([lng, lat]);
  const x = (lng + 180) / 360;
  const sl = Math.sin((lat * Math.PI) / 180);
  return { x, y: 0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI) };
}

/**
 * Create the engine. Resolves once the map's style is up and the three.js scene
 * is attached — features can be mounted from that point on.
 */
export async function createEngine({ container, mapplsKey, onStatus }) {
  onStatus?.('Loading map SDK…');
  await loadMapplsSDK(mapplsKey, onStatus);
  onStatus?.('Initialising map…');

  /* ── MOUNTING TWICE MUST BE SAFE ──────────────────────────────────────────
   * The console can mount more than once in a single page session: React's
   * StrictMode deliberately mounts → unmounts → remounts every effect in dev,
   * and navigating Overview → console does the same in any build. Both the
   * Mappls wrapper and MapLibre underneath it keep per-container state and tear
   * the previous instance down when a new one is constructed for the same
   * element — but we have already removed that map ourselves in engine.destroy,
   * so its internals are gone and the constructor throws
   * "Cannot read properties of undefined (reading 'destroy')" from inside the
   * library. That surfaced as a bare "Could not start" screen with no way back
   * except a manual reload.
   *
   * So: retire any previous engine, hand the SDK a genuinely empty container,
   * and if construction still throws, clear and retry once before giving up
   * with a message that says what to do. */
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) throw new Error(`Map container "${container}" is not in the document.`);

  if (window.__ftEngine && window.__ftEngine !== null) {
    try { window.__ftEngine.destroy?.(); } catch { /* already half-gone */ }
    window.__ftEngine = null;
    window.__map = null;
  }
  // Anything the removed map left behind — canvases, control containers — would
  // be adopted by the next instance. Start from bare.
  el.replaceChildren();

  const mapOptions = {
    center: { lat: REF_LAT, lng: REF_LNG },
    zoom: 12.6, pitch: 45, bearing: -12,
    zoomControl: false, attributionControl: false, fullscreenControl: false,
    // Required because three.js shares this GL context. Without it the drawing
    // buffer is discarded after each composite, and once three has touched the
    // context the browser composites an empty canvas — the basemap loads, draws,
    // reports healthy, and never appears.
    preserveDrawingBuffer: true,
  };
  let map;
  try {
    map = new window.mappls.Map(container, mapOptions);
  } catch (err) {
    console.warn('[engine] map construction failed, clearing and retrying once:', err);
    el.replaceChildren();
    try {
      map = new window.mappls.Map(container, mapOptions);
    } catch (err2) {
      throw new Error(`The map could not be initialised (${err2.message || err2}). Reload the page.`);
    }
  }

  const modelTransform = buildTransform();
  const toLocal = (lng, lat) => {
    const mc = merc(lng, lat);
    return {
      x: (mc.x - modelTransform.translateX) / modelTransform.scale,
      z: (mc.y - modelTransform.translateY) / modelTransform.scale,
    };
  };

  const engine = {
    THREE, map, toLocal, modelTransform,
    scene: null, camera: null, renderer: null,
    clock: 0,
    /** per-feature handles, keyed by feature id */
    layers: Object.create(null),
    /** ticked every frame while any animated feature is on */
    tickers: new Set(),
    /** called after every step change with the new step index */
    stepHandlers: new Set(),
    triggerRepaint: () => { try { map.triggerRepaint(); } catch { /* pre-style */ } },
    destroy: null,
  };

  // ── One custom layer, one scene. Every 3-D feature adds meshes to it, so we
  // pay the render-state reset once per frame rather than once per feature.
  const customLayer = {
    id: 'ft-scene', type: 'custom', renderingMode: '3d',
    onAdd(m, gl) {
      engine.camera = new THREE.Camera();
      engine.scene = new THREE.Scene();
      engine.scene.add(new THREE.AmbientLight(0xffffff, 1.0));
      engine.renderer = new THREE.WebGLRenderer({
        canvas: m.getCanvas(), context: gl, antialias: true, preserveDrawingBuffer: true,
      });
      engine.renderer.autoClear = false;
    },
    render(gl, matrix) {
      const t = modelTransform;
      const rx = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), t.rotateX);
      const ry = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 1, 0), t.rotateY);
      const rz = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 0, 1), t.rotateZ);
      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(t.translateX, t.translateY, t.translateZ)
        .scale(new THREE.Vector3(t.scale, -t.scale, t.scale))
        .multiply(rx).multiply(ry).multiply(rz);
      engine.camera.projectionMatrix = m.multiply(l);

      // ── THE VIEWPORT MUST BE RE-SYNCED EVERY FRAME ────────────────────────
      // WebGLRenderer latches the canvas size at CONSTRUCTION. onAdd runs while
      // the map is still laying out, so three captured a 652×162 canvas and then
      // called gl.viewport(0,0,652,162) on every render. MapLibre caches GL state
      // and had no idea, so it never restored its own viewport — and drew the
      // entire basemap into a 162 px strip of a 528 px buffer. The map loaded,
      // rendered, reported healthy, and looked blank.
      //
      // setViewport (not setSize — that would resize MapLibre's canvas) keeps
      // three matched to the real drawing buffer, and the explicit restore plus
      // cache invalidation below guarantees MapLibre gets it back either way.
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      engine.renderer.setViewport(0, 0, w, h);
      engine.renderer.resetState();
      engine.renderer.render(engine.scene, engine.camera);
      gl.viewport(0, 0, w, h);
      map.painter?.context?.setDirty?.();
      // never triggerRepaint() here — that is an infinite repaint loop
    },
  };

  // Debug escape hatch: ?nogl=1 boots the map WITHOUT the three.js layer, so a
  // blank-basemap report can be attributed to the scene or ruled out in one load.
  const SKIP_GL = new URLSearchParams(location.search).get('nogl') === '1';
  await new Promise((resolve) => {
    let done = false;
    const attach = () => {
      if (done) return;
      done = true;
      if (!SKIP_GL) { try { map.addLayer(customLayer); } catch (e) { console.warn('custom layer add:', e); } }
      resolve();
    };
    map.on('load', attach);
    map.on('style.load', attach);
    setTimeout(attach, 6000);   // the SDK occasionally swallows 'load'
  });

  // ── Render loop ───────────────────────────────────────────────────────────
  // Three things keep this from being the app's main cost:
  //
  //  FRAME PACING — the animated content (flowing water, caustics) is fluid at
  //  30 fps and invisibly different at 60, but every frame costs a full map
  //  repaint over a near-fullscreen transparent shader. Halving the rate halves
  //  that bill; ANIM_HZ is the one knob.
  //
  //  VISIBILITY — a backgrounded tab kept repainting the whole scene forever.
  //
  //  IDLE — with no tickers registered nothing animates, so we never ask the map
  //  to repaint at all and it can go fully quiet between interactions.
  const ANIM_HZ = 30;
  const FRAME_MS = 1000 / ANIM_HZ;
  let raf = null, last = 0, acc = 0, hidden = document.hidden;
  const onVis = () => { hidden = document.hidden; last = 0; };
  document.addEventListener('visibilitychange', onVis);
  const loop = (ts) => {
    raf = requestAnimationFrame(loop);
    if (hidden || !engine.tickers.size) { last = ts; return; }
    if (!last) last = ts;
    const dt = Math.min((ts - last) / 1000, 0.05);
    last = ts;
    acc += dt * 1000;
    if (acc < FRAME_MS) return;
    const step = acc / 1000;
    acc = 0;
    engine.clock += step;
    for (const fn of engine.tickers) { try { fn(engine.clock, step); } catch (e) { console.warn(e); } }
    engine.triggerRepaint();
  };
  raf = requestAnimationFrame(loop);

  if (window.ResizeObserver) {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (el) {
      // Coalesce to one resize per frame and skip no-op resizes — a drag on the
      // sidebar fires this dozens of times, and map.resize() reallocates the
      // drawing buffer every call.
      let pending = null, lastW = 0, lastH = 0;
      new ResizeObserver((entries) => {
        const r = entries[0]?.contentRect;
        if (r && Math.abs(r.width - lastW) < 1 && Math.abs(r.height - lastH) < 1) return;
        if (r) { lastW = r.width; lastH = r.height; }
        if (pending) return;
        pending = requestAnimationFrame(() => { pending = null; try { map.resize(); } catch { /* not ready */ } });
      }).observe(el);
    }
  }

  // Idempotent on purpose: React can call the cleanup more than once, and
  // map.remove() on an already-removed MapLibre map reads `this.style.destroy`
  // off an undefined style. Every step is individually guarded so one failure
  // cannot strand the rest of the teardown.
  let destroyed = false;
  engine.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    try { cancelAnimationFrame(raf); } catch { /* never started */ }
    try { document.removeEventListener('visibilitychange', onVis); } catch { /* noop */ }
    try { engine.tickers.clear(); engine.stepHandlers.clear(); } catch { /* noop */ }
    try { engine.renderer?.dispose?.(); } catch { /* context already lost */ }
    try { map.remove(); } catch { /* already gone */ }
    if (window.__ftEngine === engine) { window.__ftEngine = null; window.__map = null; }
  };

  // Debug handles for headless verification.
  window.__ftEngine = engine;
  window.__map = map;
  return engine;
}

/**
 * Reassert layer stacking. The Mappls style pipeline reorders layers on its own
 * `styledata` batches, so any ordering we care about has to be re-applied
 * rather than set once. Idempotent: it only moves what is already out of place.
 */
export function assertOrder(engine, { xray }) {
  const { map } = engine;
  try {
    // Only materialise the dim layer when x-ray is actually wanted. Creating a
    // world-covering fill at boot and reordering the stack around it touched the
    // style on every reconcile for a feature that is off by default.
    if (xray && !map.getLayer('xray-dim')) {
      map.addSource('xray-dim-src', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon',
          coordinates: [[[-179, -85], [179, -85], [179, 85], [-179, 85], [-179, -85]]] } },
      });
      map.addLayer({ id: 'xray-dim', type: 'fill', source: 'xray-dim-src',
        paint: { 'fill-color': '#0a1420', 'fill-opacity': 0 } });
    }
    if (!map.getLayer('xray-dim')) return;

    if (xray) {
      // Dim the FLAT basemap only, never the extruded buildings. NB the Mappls
      // style has 'sea' fill-extrusions near the BOTTOM of the stack — anchoring
      // on those puts the dim below the whole basemap, where it does nothing.
      const ord = map.style?._order || [];
      let bld = null;
      for (const id of ord) {
        const l = map.getLayer(id);
        if (l && l.type === 'fill-extrusion' && !/sea/i.test(id)) { bld = id; break; }
      }
      if (bld) map.moveLayer('xray-dim', bld);
    }
    map.setPaintProperty('xray-dim', 'fill-opacity', xray ? 0.6 : 0);
  } catch (e) {
    console.warn('layer order:', e);
  }
}
