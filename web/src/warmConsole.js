import { useTwinStore, useClient } from './lib/context.jsx';
/* ─────────────────────────────────────────────────────────────────────────────
 * warmConsole — start the console's cold path before it is asked for.
 *
 * Opening /twin used to be four round trips deep before the map could even
 * begin: bundle → /api/auth/session → import the engine chunk → /api/config →
 * the Mappls SDK. Only the last two of those genuinely depend on each other.
 * The engine chunk in particular is the big one (three.js alone is ~154 KB
 * gzipped) and it was not requested until the session check had already come
 * back, so the network sat idle through the whole auth round trip and then did
 * its largest download from a standing start.
 *
 * This starts that download early. Two callers:
 *   • RequireAuth, the instant the gate mounts — concurrent with the session
 *     fetch, so the chunk is usually parsed by the time the answer arrives.
 *   • The landing page's "Open the console" links, on hover/focus/touch. Intent
 *     precedes the click by a few hundred milliseconds, which is most of the
 *     chunk.
 *
 * CODE ONLY, NEVER DATA. RequireAuth's contract is that a visitor who has not
 * signed in does not pull the simulation binaries, and the landing page's is
 * that it never runs three.js or the Mappls SDK. Both survive: this warms the
 * module graph into the HTTP/module cache, and nothing here constructs a map,
 * touches WebGL or fetches /sim. The engine only runs when startTwin is called,
 * which still happens behind the gate.
 *
 * Idempotent and failure-tolerant: a warm-up that loses a race with the real
 * import is free (the module cache dedupes), and one that fails is silent —
 * the real import will surface the error properly.
 * ─────────────────────────────────────────────────────────────────────────── */



let warmed = null;

export function warmConsole() {
  if (!warmed) {
    warmed = import('./engine/controller.js').catch(() => {
      // Swallowed on purpose. If the chunk is genuinely unreachable, the real
      // import in MapCanvas raises it where the boot overlay can show it — and
      // controller.js has the stale-build reload path for the deploy case.
      // Reset so the real import is not handed a rejected promise.
      warmed = null;
    });
  }
  return warmed;
}

/** Props that warm on intent. Spread onto a link: <Link {...onIntent()} /> */
export function onIntent() {
  return {
    onMouseEnter: warmConsole,
    onFocus: warmConsole,
    onTouchStart: warmConsole,
  };
}

/* ── heavy layers, warmed the same way ──────────────────────────────────────
 *
 * The drainage network is the console's biggest single click: ~2.4 MB gzipped
 * of node/link geometry, a chunk to import, and then a ~0.5 s synchronous build
 * of 139,798 conduits. None of it starts until the toggle is pressed, so the
 * whole cost lands after the click with the UI already committed to responding.
 *
 * Hovering the row is a few hundred milliseconds of warning, and that is enough
 * to have the fetches in flight and the chunk parsed before the press lands.
 * Nothing is BUILT here — no WebGL, no geometry, no store writes — so warming a
 * layer the user then does not open costs a cached download and nothing else.
 * The real mount still does all its own work; these fetches only prime the HTTP
 * cache so its `fetch()` calls resolve from it.
 *
 * Keyed per feature so hovering ten times fires once. */
const LAYER_WARM = {
  drainage: {
    // Versioned, exactly as simData asks for them. This has to MATCH: the data
    // routes now freeze any url carrying a ?v=, so a warm-up that fetched the
    // bare path would prime a cache entry under a key the real load never looks
    // up — paying for the download twice and warming nothing.
    urls: (v) => [
      '/sim/drain_geom.bin',
      '/sim/drain_node_static.bin',
      '/sim/drain_link_static.bin',
      '/sim/drain_link_class.bin',
      '/sim/drain_node_class.bin',
    ].map((u) => (v ? `${u}?v=${encodeURIComponent(v)}` : u)),
    chunk: () => import('./engine/drainageViz.js'),
  },
  sewer: {
    urls: () => ['/drainage/sewer_network.geojson'],
    chunk: () => import('./engine/sewerLayer.js'),
  },
};

const layerWarmed = new Set();

/**
 * @param {string} id      Feature to warm.
 * @param {object} store   The console instance's store — the manifest carries
 *                         the ?v= these urls must match.
 * @param {object} client  The instance's HTTP client. Warming with a bare
 *                         fetch() would prime the wrong origin entirely in an
 *                         embed, so the warm has to go the same way the real
 *                         load will.
 */
export function warmLayer(id, store, client) {
  const spec = LAYER_WARM[id];
  if (!spec || layerWarmed.has(id) || !store || !client) return;
  layerWarmed.add(id);
  spec.chunk().catch(() => {});
  // Read lazily off the store so this module stays importable from the landing
  // page without dragging the engine in. The manifest is always loaded by the
  // time a layer row can be hovered.
  const man = store.getState().manifest;
  for (const u of spec.urls(man?.static_version || man?.version)) {
    client.raw(u).catch(() => {});
  }
}

/**
 * Hook form, because the warm now needs this instance's store and client.
 *
 * Spread onto a layer toggle:
 *   const onLayerIntent = useLayerIntent();
 *   <button {...onLayerIntent(feature.id)} />
 */
export function useLayerIntent() {
  const store = useTwinStore();
  const client = useClient();
  return (id) => {
    if (!LAYER_WARM[id]) return {};      // nothing heavy behind this one
    const warm = () => warmLayer(id, store, client);
    return { onMouseEnter: warm, onFocus: warm, onTouchStart: warm };
  };
}
