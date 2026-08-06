# FloodTwin — Gurugram flood digital twin

Coupled 2-D surface flow and 1-D storm-drain hydraulics on one timeline: the
sheet on the street and the water in the pipe beneath it are the same solve, at
the same instant. Two datasets — the 09-Jul-2025 event reconstruction and the
MCG partner's daily forecast — behind one switch.

Provenance for every layer, and the record of what synthetic data was removed,
is in [`DATA_PROVENANCE.md`](DATA_PROVENANCE.md).

---

## Layout

```
floodtwin3/
├─ server.py               entry point — `python server.py`, or `gunicorn server:app`
├─ floodtwin/              Flask app: data + API only, no HTML templating
│  ├─ __init__.py          create_app(): registers the blueprints
│  ├─ config.py            paths, keys, cache policy
│  ├─ http.py              cache headers + on-the-fly gzip for the binaries
│  └─ routes/
│     ├─ data.py           /sim /live /drainage /wards … the datasets
│     ├─ assets.py         /api/assets — Google Places, Overpass fallback
│     ├─ geo.py            /api/config /api/geocode /api/locality /api/route
│     ├─ partner.py        /api/live-forecast/* — partner proxy + freshness
│     └─ pages.py          serves the built React bundle
│
├─ web/                    React front-end (Vite)
│  └─ src/
│     ├─ pages/            Landing.jsx (/) · Console.jsx (/twin)
│     ├─ features/registry.js   THE feature catalogue — drives both surfaces
│     ├─ store/useTwin.js  one zustand store; React reads it, the engine subscribes
│     ├─ components/       LayersPanel · MapCanvas · panels (time, legend, hotspots…)
│     └─ engine/           imperative renderer — React never touches WebGL
│        ├─ core.js        Mappls map + one three.js custom layer + render loop
│        ├─ controller.js  the only place store state becomes WebGL state
│        ├─ palette.js     the zoom.earth depth ramp (shared by sheet + pipes)
│        ├─ simData.js     manifests, depth grids, network geometry, hotspots
│        ├─ floodSurface.js   the 2-D flood sheet
│        ├─ drainageViz.js    the buried pipes
│        └─ assetsLayer · sewerLayer · roadsLayer · drainageAssets · buildings
│
├─ drainage/
│  ├─ sim/                 coupled run, transcoded (13 hourly frames)
│  ├─ live/                partner forecast, transcoded (145 × 10-min frames)
│  └─ web/                 recorded MCG/GMDA inventories + sewer_network.geojson
│
├─ build_sewer_network.py  MCG sewer CSV → sewer_network.geojson
├─ build_link_classes.py   storm/sewer class per solved conduit → drain_*_class.bin
├─ build_sim_binaries.py   coupled run NPZ → drainage/sim/
├─ build_live_forecast.py  partner API → drainage/live/
└─ legacy/                 the superseded vanilla front-end, for reference
```

## Running it

```bash
# once
cd web && npm install && npm run build && cd ..

# then
python server.py                 # http://localhost:9121
```

Front-end development, with hot reload:

```bash
python server.py                 # API + data on :9121
cd web && npm run dev            # UI on :5173, proxying /api /sim /live /drainage
```

`npm run build` writes to `static/dist`, which Flask serves. **A template change
no longer needs a server restart** — there are no templates.

## Configuration

`.env` in this directory (gitignored):

```
MAPPLS_API_KEY=…             # basemap; also proxied for routing
GOOGLE_PLACES_API_KEY=…      # critical assets + search. Omit → OSM/Overpass fallback
FLOODTWIN_PARTNER_API_KEY=…  # MCG daily forecast. Omit → event dataset only
```

No key is ever sent to the browser. The client reads `/api/config`, which exposes
only the Mappls key the map SDK genuinely needs.

## Adding a feature

Add one entry to `web/src/features/registry.js` and one builder to
`web/src/engine/controller.js`. The landing page's feature grid, the console's
Layers panel and the lazy-mount plumbing all follow from the registry — there is
no second list to keep in sync.

The independence contract: a feature handler may touch only its own handle.
Anything global (the x-ray dim, layer stacking order) is recomputed from the
whole current state in `reconcile()`, never by one feature writing another's flag.

## The daily forecast pipeline — measured timings

The partner's run is named for its 23:30 init, but it only becomes fetchable
around **05:00–05:20 IST**. `refresh_live_forecast.sh` (cron, every 20 min) polls
for a new `run_id` rather than guessing a clock time; it exits in ~0.5 s when
nothing changed, and `flock` stops a slow rebuild overlapping the next tick.

Measured on 04-Aug-2026 (`newmodel_partner_daily_20260803_233000_518eac4f`):

| Stage | Time |
|---|---|
| Partner run becomes fetchable | ~05:00–05:20 IST |
| Cron picks it up | within 20 min of publication (05:20:01) |
| Download + transcode 145 frames → 248 MB | **19 min 30 s** (05:20:09 → 05:39:39) |
| **Ready in the app** | **~05:40 IST** |

Staging is atomic, so `/live` never serves a half-written dataset — the app keeps
playing yesterday's run until the new one swaps in whole.

What a *user* then waits for is much smaller, because the app streams frames
rather than the dataset:

| Action | Payload | Time |
|---|---|---|
| Switch Event → Live Forecast | manifest 6 KB + one grid frame | **1.5 s** |
| Scrub to an uncached frame | ~1–150 KB gzipped | **0.7 s** |
| Cold console load (event) | bundle 74 KB gz + three 149 KB gz + manifest + 1 grid | **4.1 s** on a *software* GL renderer — well under that on a real GPU |

So: the run is in the app by ~05:40, and opening it costs a second or two, not a
238 MB download.

## Confirming there is no synthetic data

`scripts/audit.js` boots the console, switches on every layer, scrubs the
timeline, exercises both datasets and the search, and records **every** network
request the app makes. The resulting table — each request traced to a named
source — is kept in [`DATA_PROVENANCE.md`](DATA_PROVENANCE.md). Run it after any
change that adds a fetch:

```bash
python server.py &          # audit drives the real app
node scripts/audit.js
```

## Notes worth knowing

* **The boot chain runs in parallel, not in series.** config → SDK → map →
  manifest → grid → paint was five sequential round trips even though only one
  actually depends on another: the flood data does not need the API key, and the
  first frame's filename is fixed, so `/api/config`, `/sim/manifest.json` and
  `surface_grid_00.bin` all go out together while the Mappls SDK downloads.
  Default-on features then mount CONCURRENTLY (they are independent by contract),
  instead of each stacking a dynamic import plus a fetch onto the critical path.
  4.06 s to interactive, from 6.7 s.
* **Cold load is the map, the manifest and one 768² depth grid.** Every other
  layer mounts lazily the first time you switch it on — the drainage network
  (~10 MB of geometry), the sewer inventory (~1 MB gzipped) and the asset index
  cost nothing until requested. The 44 MB of legacy scenario polygons
  (`coordinates.bin` + `chunks/` + `polygon_index.json`) are no longer fetched at
  all; depth-at-a-point now comes from the run's own grid in O(1).
* **Never let MapLibre size its own container.** MapLibre stamps
  `.maplibregl-map { position: relative }` on whatever element you hand it, which
  beats a plain `.map-host { position: absolute }` on specificity. The container
  then sizes to its CONTENT (the canvas) while the canvas sizes to the container
  — a feedback loop that settles on an arbitrary box. The symptom is brutal to
  diagnose: tiles 200, glyphs 200, GL context valid, `gl.readPixels` shows a
  fully-painted opaque framebuffer, `elementsFromPoint` returns the canvas on
  top — **and the map is blank**, because the backing store never matches the CSS
  box. Pin it with `.map-shell > .map-host.maplibregl-map { position:absolute;
  inset:0; width:100%; height:100% }` and call `map.resize()` once the boot
  overlay unmounts. Tell: `map.loaded()` stays `false` forever.
* **three.js latches the canvas size at construction.** `new WebGLRenderer({canvas,
  context})` records `canvas.width/height` once; if the custom layer's `onAdd`
  runs mid-layout it captures a stub size (we caught 652×162) and then calls
  `gl.viewport(0,0,652,162)` every frame. MapLibre caches GL state and never
  restores its own viewport, so the basemap gets drawn into a strip. Re-sync each
  frame with `renderer.setViewport(0, 0, gl.drawingBufferWidth,
  gl.drawingBufferHeight)` — **not** `setSize()`, which would resize MapLibre's
  canvas — then restore `gl.viewport` and call `map.painter.context.setDirty()`.
* `static/maptest.html` is a bare Mappls map with no React and no three.js. When
  the console renders nothing, open it: if it works, the fault is in the engine,
  not the SDK, key, or network. That one comparison is what localised the bug.
* **Symbol layers must set `text-font` explicitly.** MapLibre's default stack is
  `Open Sans Regular,Arial Unicode MS Regular`; the Mappls glyph CDN **403s that
  composite stack** (single-font stacks return 200), and the layer then draws no
  text at all — which for a cluster bubble means no count. Add layers with
  `addLayerSafe(map, layer)` from `engine/core.js`, which fills the font in.
  Do NOT monkey-patch `map.addLayer` to do this: the Mappls wrapper re-enters its
  own `addLayer`, so the wrapper calls itself until the stack blows.
* **Frame files are named with Python's `{i:02d}` — a MINIMUM width.** Frame 7 is
  `07`, frame 144 is `144`. Padding the 145-frame forecast to three digits asks
  for `surface_grid_000.bin`, which does not exist, and every live frame under
  100 404s.
* **The store subscriber advances its `prev` snapshot before dispatching.** Any
  handler that writes to the store on its first line (a status message, a stat)
  re-enters the subscriber synchronously; if `prev` has not moved, it sees the
  same diff and recurses forever.
* **Never give zustand a selector that builds a new object.**
  `useTwin(s => ({a: s.a, b: s.b}))` hands `useSyncExternalStore` a fresh
  snapshot every read and React re-renders until the stack overflows. Select
  fields individually.
* **The Mappls style reshuffles its layers** as tiles stream in, so anything
  order-dependent (the x-ray dim, the road overlay, the 3-D scene) is re-asserted
  on `styledata` rather than positioned once.
* **The solved network is storm AND sewer, but doesn't say so.** Neither the
  binaries nor the partner API carry `network_type`. The split is recovered from
  the MCG inventory by endpoint matching (`build_link_classes.py`) — which is
  what lets the forecast drive both. Re-run it if the run's network changes.
* **Marker families must stay visually separate.** Drainage assets are angular and
  infrastructure-coloured (dark squares for gully pits, teal ▼ for outfalls,
  stone/amber squares for pumps); critical assets are round, white-ringed and
  lettered (H/S/C/F/P/R). Both were plain circles once and were indistinguishable
  on a dense map.
* **Depth exaggeration is 3.5×, not 8×.** At 8× a 3 m-deep node sat 24 m under
  the street — deeper than the buildings above are tall, which read as a bug.
  Manhole shafts are drawn only at junctions buried ≥1.2 m, at 0.26 m radius.
* **Pipe clutter is solved by zoom, not by dropping links.** An earlier
  flow-threshold LOD kept 14 % of conduits and deleted the connective tissue
  between reaches, so the network rendered as floating fragments. All 139,798
  links are built; tiers gate in by zoom (trunk always, branch ≥ 13.2, laterals
  ≥ 15), and any tier can be pinned on or off.
* **Flood-sheet smoothing is zoom-dependent, and has two knobs.** `uBlur` widens
  the depth kernel as you pull back (1 → 4 texels) because at city zoom several
  33 m cells collapse into one pixel and a fixed texel-width blur is sub-pixel,
  i.e. useless. `uWetMin` rises alongside it, because blurring alone leaves
  isolated shallow cells as speckle — requiring a deeper average to draw at all
  is what makes the coarse view read as pools. The kernel is TWO rings: a single
  3×3 at wide spacing under-samples and the speckle survives.
* **The surface flood and the in-pipe water use DIFFERENT ramps, deliberately.**
  The sheet uses zoom.earth's precipitation LUT (`palette.js`) — a 256×1 texture
  with LINEAR filtering, continuous by construction. The pipes use `pipeWater()`,
  a blue gradient on FILL: sharing the precipitation ramp turned a running
  conduit magenta/orange, which read as an alarm rather than as water. Blue says
  "water", and the ramp still says "how much" because it is strictly monotonic —
  pale when nearly empty, deep blue when running full.
* **Pipe geometry: R=10 radial segments, collinear decimation, junction pull-back.**
  At R=5 the cross-section was a visible pentagon and the water clipped against
  it came out faceted. R=10 reads as a cylinder; the cost is paid back by
  dropping interior rings whose turn is under 7° (192,603 → 131,850 rings, −32%),
  so round pipes cost only ~25% more than the old faceted ones. Chains are also
  pulled back from any node of degree ≥3, so conduits stop short of a junction
  and the manhole shaft reads as the joint instead of tubes interpenetrating
  into a knot. NB the decimation test must be GEOMETRY-ONLY — keying it on the
  conduit slot as well makes it a no-op, because every node in a chain belongs
  to a different link.
* Kill a stale server by port PID (`ss -ltnp | grep 9121`), not
  `pkill -f server.py` — that matches the invoking shell.
* Visual changes to the drainage are only honestly checkable at **zoom ≥ 18**
  with the flood opacity at 0. Headless tooling: `/home/meet/render-tools`.
