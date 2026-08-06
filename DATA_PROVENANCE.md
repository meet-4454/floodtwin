# Data provenance & synthetic-data audit

Audited 2026-08-03, as part of the React rebuild. Every dataset the app can load
is listed below with its source and whether it is real or derived. **Anything
synthetic that was still reachable has been removed from the app**, and the
replacements are named.

Rule applied throughout: a layer either shows recorded data, or shows the output
of the coupled physics run — never a plausible-looking stand-in.

---

## ✅ Real — in use

| Layer | Source | Notes |
|---|---|---|
| 2-D flood sheet | `drainage/sim/surface_grid_NN.bin` | Fused CUDA full shallow-water + Horton infiltration, forced by the **reported** 09-Jul-2025 rainfall (133 mm / 12 h), with outfall tailwater priors and surface recharge in the physics. 981,880 surface triangles rasterised to a 768² grid. Mass residual 0.22 %. |
| Storm-drain network (3D) | `drainage/sim/drain_geom.bin`, `drain_node_static.bin`, `drain_link_static.bin`, `drain_dyn_NN.bin` | The run's **own** 118,768 nodes / 139,798 links. Water level per pipe = that node's solved depth ÷ its own max depth. Surcharge comes from the run's per-frame bitmask (verified to match `hourly_drainage_summary.csv` at h0/1/7/8/9/12). |
| Live forecast | `drainage/live/*` via `build_live_forecast.py` | MCG partner's daily coupled 2-D+1-D run, 145 frames @ 10 min. Indexes the same node/link ids, so geometry is shared. |
| **Storm / sewer split** | `drainage/sim/drain_link_class.bin`, `drain_node_class.bin` | **NEW.** The coupled run ships ONE undifferentiated network and the partner API's per-frame GeoJSON carries only `drainage_node` / `drainage_link` — no `network_type`. But that network **is** the MCG storm+sewer inventory: 139,798 links vs the inventory's 141,821 segments, and 91.9 % of sewer chain endpoints sit within 8 m of a solved node at a **median 0.21 m**. `build_link_classes.py` recovers the split by matching endpoint pairs → **21,910 storm + 87,606 sewer + 30,282 unmatched**. Unmatched conduits stay class 2 ("unclassified") and are rendered as such — never guessed into a category. This is what lets BOTH storm and sewer drains be driven by the forecast. |
| **Sewerage network (2-D inventory)** | `drainage/web/sewer_network.geojson` | **NEW.** Built by `build_sewer_network.py` from `d_june_5_actual_storm_plus_sewer_segments.csv` — MCG/GMDA's own utility inventory. 113,757 surveyed sewer segments → 45,787 mains, 1,979.6 km, with recorded diameter, material, cover depth, absolute inverts and Manning full-flow capacity. |
| Side-entry pits / gullies | `drainage/web/inlets_rim.geojson` | 5,922 MCG pits with rim levels. |
| Outfalls | `drainage/web/outfalls.geojson` | Network discharge register. |
| Storm pumps | `drainage/web/pumps.geojson` | 50 MCG pumps with recorded activation/stop depths. "Running" is decided by the **solved** depth at the pump vs its own activation depth. |
| Ward boundaries | `wards_gurugram.geojson` | MCG wards. |
| Critical assets | Google Places (New) via `/api/assets` | ~1,300 POIs, 4×4 grid-tiled and deduped by place id. OSM/Overpass fallback. |
| Road geometry | Mappls basemap rendered features | Real road network; passability is that geometry sampled against the run's depth grid. |
| 3-D buildings | Mappls vector basemap `fill-extrusion` layers | The basemap's own footprints. |

## 🚩 Flagged as synthetic / mis-scoped — REMOVED from the app

| What | Why it was flagged | What replaced it |
|---|---|---|
| **3-D City (LULC) overlay** — `prediction.geojson` (46 MB), `trees.glb`, `cricket_stadium.glb`, `football.glb` | The polygons are anchored at **72.6881 E, 23.2144 N — Ahmedabad/IITGN, not Gurugram**. It placed procedurally-scattered trees, a cricket stadium and a football pitch over a *different city*. | Removed. The Mappls basemap's real building extrusions are now an explicit, independent layer instead. |
| **"Campus life"** — `populateCampusLife()` vehicles + people billboards | Purely procedural: boxes marched along road paths and sprites scattered at `CITY_REF ± random()`. Decorative animation presented inside an analytical console. | Removed outright. |
| **Legacy scenario flood** — `coordinates.bin` (27 MB), `chunks/*.bin` (21 MB), `polygon_index.json` (17 MB) | An **older, different** GPU scenario than the drainage network was showing — the two were never the same event. It was also ~44 MB of the cold load. | The coupled run's own depth grid drives everything (sheet, popups, roads, hotspots, pumps, assets). Routes kept for archival access; the app no longer fetches them. |
| **Derived drainage hydraulics** — `util_pk`, `v_ms`, `t_arr_min`, `storageFracAt()`, `perfFillFrac()`, `SEWER_BASE_FILL`, wave-front `WAVE_TIME_SCALE` exaggeration | Manning/rational-method **proxies** used to fake fill levels before a real solve existed, including a disclosed 3× time exaggeration. | The solved per-node depth from the coupled run. No proxy remains in the render path. |
| **Synthetic SWMM chain layers** — `storm_network.geojson`, `sewer_network.geojson` (old chain build), `catchments`, `recharge_candidates`, `pump_discharge`, `inlet_links`, `link_dynamics`, STP nodes, silt overlay | Outputs of `build_drainage_swmm.py` / `build_drainage_web_v2.py` / `build_recharge_zones.py` — a *modelled* network with rational-method forcing, superseded by the real coupled run. The old code still tried to `fetch()` two of these (they 404'd). | Fetches deleted. The route whitelist now allows only recorded inventories plus the new real `sewer_network`. |
| **Recharge zones** | Derived from SWMM node ponding — **not** an official CGWB/GMDA dataset, despite reading like one. | Removed. No recharge dataset exists in this repo; supply one to reinstate the layer. |

## ⚠️ Derived, but honestly labelled (kept)

* **Storm/sewer conduit class** — recovered by spatial matching against the MCG
  inventory, not stated by the solver. 78.3 % of links match; the remaining
  21.7 % are shown as "Unclassified", with their own toggle and count, rather
  than being assigned to whichever class looked more likely.

* **Flood hotspots** — a ranking of the real depth grid into ~600 m cells. Derived by construction, and described as such in the UI.
* **Locality names** on hotspots — OSM/Nominatim reverse geocoding.
* **Pipe tiers** (trunk / branch / lateral) — a presentation bucket from each conduit's own peak solved flow, used only to decide draw order and zoom gating.
* **Inlet→node association** — the shared data has no explicit inlet→node table, so pits are matched to the nearest solved node. Only used for placement.

## Files left on disk but unused by the app

`prediction.geojson`, `coordinates.bin`, `chunks/`, `polygon_index.json`,
`trees.glb`, `cricket_stadium.glb`, `football.glb`, `terrain.bin`/`terrain.json`,
`drainage/web/drain_network.geojson` (legacy static extract).
`d_june_5_actual_storm_plus_sewer_segments.csv.gz` (13 MB, was 186 MB plain) is
**real source data** — it is what `build_sewer_network.py` and
`build_link_classes.py` consume, and it is **not in git**, so deleting it makes
the sewer layer and the storm/sewer split unregenerable. Nothing reads it at
runtime, so it is stored gzipped; both scripts open either form transparently
(`open_inventory()`), and both were verified to produce byte-identical output
from the compressed file.

## Verification: every request the running app makes

Re-run any time with the audit harness. The console was booted, **every layer
switched on** (including all six asset categories), the timeline scrubbed, both
datasets exercised and the search used. Every network request was captured and
traced. Result — 2026-08-04, zero JS errors, zero HTTP ≥ 400:

| Request | Source | Real? |
|---|---|---|
| `/sim/manifest.json`, `surface_grid_NN.bin`, `drain_dyn_NN.bin` | coupled `full_12h_run` | ✅ physics output |
| `/sim/drain_geom · node_static · link_static .bin` | same run's network geometry | ✅ |
| `/sim/drain_link_class · drain_node_class .bin` | derived from the MCG inventory by endpoint match; unmatched stay "unclassified" | ⚠️ derived, labelled |
| `/live/manifest.json`, `surface_grid_NNN.bin`, `drain_dyn_NNN.bin` | MCG partner daily forecast | ✅ partner output |
| `/drainage/inlets_rim · outfalls · pumps · sewer_network .geojson` | MCG/GMDA recorded inventories | ✅ |
| `/wards_gurugram.geojson` | MCG ward boundaries | ✅ |
| `/api/assets` | Google Places (New), Overpass fallback | ✅ |
| `/api/geocode/autocomplete`, `/api/locality` | Google Places / OSM Nominatim | ✅ |
| `/api/live-forecast/status` | partner run freshness | ✅ |
| `/api/config` | the Mappls key only | — |
| `mt4.mappls.com/.../vector_tile/pbf` | Mappls basemap tiles (base, label, world) | ✅ |
| `apis.mappls.com/.../map_sdk`, `cdn.mappls.com/.../glyphs · sprites` | Mappls SDK assets | ✅ |
| `fonts.googleapis.com`, `fonts.gstatic.com` | UI webfonts | — |
| `/assets/*.js`, `*.css`, `/static/AIRESQ_LOGO.png` | the app bundle | — |

**Nothing else is requested.** No `prediction.geojson`, no `coordinates.bin`, no
`chunks/`, no `polygon_index.json`, no GLB props, no synthetic SWMM layer. The
only entry that is not a direct measurement or model output is the storm/sewer
class, which is explicitly labelled as derived and exposes its unmatched
remainder as its own toggle.

```bash
node scripts/audit.js        # regenerates the table above (needs the server running)
```

## Rebuilding

```bash
python3 build_sewer_network.py     # sewer inventory → drainage/web/sewer_network.geojson
                                   # (reads the .csv or .csv.gz, whichever is present)
python3 build_link_classes.py      # storm/sewer split → drainage/sim/drain_*_class.bin
python3 build_sim_binaries.py      # coupled run     → drainage/sim/
python3 build_live_forecast.py     # partner forecast → drainage/live/
```
