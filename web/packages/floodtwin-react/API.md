# FloodTwin API reference

For integrating teams whose **backend** calls FloodTwin directly — to proxy the
console, to pull visualisation results, or to reconcile usage.

If you only want the console embedded, you need [`INTEGRATION.md`](./INTEGRATION.md)
and about ten lines of code; this document is the layer underneath it.

* Base URL — supplied with your key (`https://<host>`). All paths below are
  relative to it.
* Everything is `GET`. Nothing here has side effects except spending quota.
* All error bodies are JSON. Success bodies are JSON, GeoJSON, or binary as
  noted per endpoint.

---

## 1. Authentication

Send your key on **either** header:

```http
X-FloodTwin-Key: ft_live_…
Authorization: Bearer ft_live_…
```

There is no login, no token exchange and no expiry — the key *is* the
credential. There is nothing to refresh.

**The key is a server-side secret.** It is not origin-restricted and not
scoped to a browser, so anything holding it can spend your quota. Keep it in
your backend's environment; requests from a browser must go through your own
server. See [`examples/express-proxy.mjs`](./examples/express-proxy.mjs).

Our own web console authenticates with a session cookie instead. Both are
accepted; you will only ever use the key.

### Errors

| Status | `error` | Meaning |
|---|---|---|
| 401 | `key_required` | No key on the request. |
| 401 | `invalid_key` | Unknown, malformed, or revoked. Deliberately indistinguishable. |
| 403 | `scope_denied` | Valid key, but not entitled to that endpoint. Body has `scope` and `granted`. |
| 429 | `rate_limited` | Over the per-minute burst. `Retry-After` in seconds. |
| 429 | `quota_exceeded` | Daily billed quota spent. `Retry-After` = seconds to UTC midnight. |
| 400 | `bad_bbox`, `bbox_outside_service_area`, `bbox_too_large`, `bbox_too_small` | See `/api/assets`. |
| 404 | `not_found` | No such path or dataset frame. |
| 502 | — | A third-party provider we proxy (Google, Mappls) failed. |
| 503 | — | That provider is not configured on our side. |

```json
{ "error": "scope_denied", "scope": "assets", "granted": ["sim", "drainage"] }
```

### Scopes

Your key carries a subset. `/api/usage` reports which.

| Scope | Endpoints | Billed |
|---|---|---|
| `sim` | `/sim/*`, `/live/*`, `/Gurugram_wards.geojson`, `/Gurugram_district.geojson` | no |
| `drainage` | `/drainage/*` | no |
| `config` | `/api/config` | no |
| `live` | `/api/live-forecast/*` | no |
| `assets` | `/api/assets` | **yes** |
| `geocode` | `/api/geocode/*`, `/api/locality` | **yes** |
| `route` | `/api/route` | **yes** |

"Billed" means the call draws on shared Google/Mappls quota and counts against
your daily limit. Cached responses are not re-billed.

### Caching — please honour it

The simulation binaries are large and immutable. Every response carries `ETag`
and `Last-Modified`; send `If-None-Match` and you get `304 Not Modified` with no
body. `Accept-Encoding: gzip` gets pre-compressed bytes.

An integration that ignores these re-downloads ~15 MB per page load. It is the
single most common cause of "the console feels slow".

---

## 2. Datasets

Two, identical in format and interchangeable at runtime.

| | `/sim` — event | `/live` — forecast |
|---|---|---|
| What | Reconstruction of the 09 Jul 2025 storm (133 mm / 12 h) | Partner's daily coupled run |
| Frames | 13, hourly | ~145, every 10 min, ~24 h ahead |
| Updated | never | daily |

They index the **same** network, so node/link geometry is shared: fetch
`drain_geom.bin` etc. from `/sim` once and reuse it for both. `/live`'s manifest
says so explicitly via `static_from: "/sim"`.

### `GET /sim/manifest.json` · `GET /live/manifest.json`

Read this first — every binary below is decoded using its numbers.

```json
{
  "source": "full_12h_run (fused CUDA full_SWE + Horton, july2025_reported_133mm_12h)",
  "n_hours": 13,
  "n_nodes": 118768,
  "n_links": 139798,
  "n_verts": 499901,
  "n_tris": 981880,
  "depth_scale": 1000.0,
  "flow_scale": 100.0,
  "wet_threshold_m": 0.05,
  "grid_n": 768,
  "grid_bbox": [76.92743352, 28.32395085, 77.18375956, 28.54708565],
  "hours": [0.0, 1.0, 2.0, "…"],
  "outfall_nodes": [202, 307, 454, "…"],
  "rainfall_total_mm": 133.0,
  "duration_min": 720.0
}
```

| Field | Meaning |
|---|---|
| `n_hours` | Frame count. Frame indices are `0 … n_hours-1`. |
| `n_nodes`, `n_links` | Drainage network size. Fixed across frames. |
| `depth_scale` | Divide stored `uint16` depths by this for **metres**. |
| `flow_scale` | Divide stored `int16` flows by this for **m³/s**. |
| `grid_n` | Depth grid is `grid_n × grid_n`. |
| `grid_bbox` | `[west, south, east, north]` in WGS84 degrees. |
| `outfall_nodes` | Node indices that discharge out of the system. |
| `wet_threshold_m` | Depth at or above which a cell counts as flooded. |

`/live` adds:

```json
{
  "dataset": "live_forecast",
  "run_id": "newmodel_partner_daily_20260812_233000_82ae1e27",
  "base_valid_time": "2026-08-13T05:00:00+05:30",
  "time_step_min": 10.0,
  "generated_at": "2026-08-13T05:39:55+0530",
  "static_from": "/sim",
  "frames": [
    { "index": 0, "minute": 0.0, "valid_time": "D202608130500",
      "valid_at": "2026-08-13T05:00:00+05:30", "intensity_mmhr": 0.0,
      "nodes": 118733, "links": 102559, "surcharged": 418,
      "wet_cells": 150, "max_depth_m": 1.0172 }
  ]
}
```

`frames[i]` gives per-frame statistics without downloading the frame — enough to
plot a hydrograph, find the peak, or drive a timeline UI on its own.

> **Frame numbering.** Files are named with Python's `{i:02d}`, a *minimum*
> width, not a fixed one: frame 7 is `07`, frame 144 is `144`. Zero-padding
> everything to three digits 404s on the first hundred frames of `/live`.

---

## 3. Simulation binaries

Little-endian, no header, no padding. Decode with the manifest's counts.

### `GET /{sim|live}/surface_grid_{i}.bin` — surface flood depth

The main visualisation product: a regular depth raster per frame.

* `Uint16[grid_n × grid_n]`, row-major, **south-to-north**, west-to-east.
* Metres = `value / depth_scale`.
* Cell `(x, y)` covers
  `lng = grid_bbox[0] + x/(grid_n-1) × (grid_bbox[2]-grid_bbox[0])`,
  `lat = grid_bbox[1] + y/(grid_n-1) × (grid_bbox[3]-grid_bbox[1])`.

768² × 2 bytes = 1,179,648 bytes raw; ~50–200 KB gzipped.

```python
import numpy as np, requests
H = {"X-FloodTwin-Key": KEY}
man = requests.get(f"{BASE}/sim/manifest.json", headers=H).json()
raw = requests.get(f"{BASE}/sim/surface_grid_00.bin", headers=H).content
n   = man["grid_n"]
depth_m = np.frombuffer(raw, "<u2").reshape(n, n) / man["depth_scale"]

w, s, e, nth = man["grid_bbox"]
print("max depth", depth_m.max(), "m")
print("flooded area fraction",
      (depth_m >= man["wet_threshold_m"]).mean())
```

To sample a point, index directly — no interpolation needed for most uses:

```python
def depth_at(lng, lat):
    if not (w <= lng <= e and s <= lat <= nth):
        return 0.0
    x = round((lng - w) / (e - w) * (n - 1))
    y = round((lat - s) / (nth - s) * (n - 1))
    return float(depth_m[y, x])
```

### `GET /{sim|live}/drain_dyn_{i}.bin` — drainage state per frame

Three arrays concatenated, in this order:

| # | Type | Length | Meaning |
|---|---|---|---|
| 1 | `Uint16` | `n_nodes` | Water depth at node. Metres = `/ depth_scale`. |
| 2 | `Uint8` | `ceil(n_nodes / 8)` | Surcharge bitmask, LSB-first. |
| 3 | `Int16` | `n_links` | Flow in conduit. m³/s = `/ flow_scale`. Sign = direction. |

Node `i` is surcharging (backing up to street level) when
`mask[i >> 3] & (1 << (i & 7))` is set.

```python
nn, nl = man["n_nodes"], man["n_links"]
mask_b = (nn + 7) // 8
raw = requests.get(f"{BASE}/sim/drain_dyn_00.bin", headers=H).content

node_depth = np.frombuffer(raw, "<u2", count=nn) / man["depth_scale"]
surcharge  = np.unpackbits(
    np.frombuffer(raw, "u1", count=mask_b, offset=nn * 2),
    bitorder="little")[:nn].astype(bool)
flow       = np.frombuffer(raw, "<i2", count=nl,
                           offset=nn * 2 + mask_b) / man["flow_scale"]

print(surcharge.sum(), "nodes surcharging")
```

### `GET /sim/drain_geom.bin` — network geometry

Fetch **once**; identical for both datasets.

| # | Type | Length | Meaning |
|---|---|---|---|
| 1 | `Float32` | `n_nodes × 2` | `lng, lat` per node, interleaved. |
| 2 | `Uint32` | `n_links × 2` | `from_node, to_node` index pair per link. |

The second array starts at byte offset `n_nodes × 8`.

```python
raw = requests.get(f"{BASE}/sim/drain_geom.bin", headers=H).content
lonlat = np.frombuffer(raw, "<f4", count=nn * 2).reshape(nn, 2)
links  = np.frombuffer(raw, "<u4", count=nl * 2,
                       offset=nn * 8).reshape(nl, 2)
```

### `GET /sim/drain_node_static.bin`

`Float32[n_nodes × 3]` — `invert_level_m`, `max_depth_m`, `surface_area_m2`
per node. Invert is the pipe bottom's elevation; a node is full when its water
depth reaches `max_depth_m`.

### `GET /sim/drain_link_static.bin`

`Float32[n_links]` — peak absolute flow per conduit over the whole run. Divide a
frame's flow by this for a 0–1 utilisation ratio.

### `GET /sim/drain_link_class.bin` · `GET /sim/drain_node_class.bin`

`Uint8` per link / node: `0` = storm drain, `1` = foul sewer, `2` = unclassified.

Optional — may 404. Treat absence as "all unclassified" rather than an error.
The solver models one undifferentiated network; the split is recovered by
matching against the MCG sewer inventory (91.9 % of chain endpoints land on a
solved node, median 0.21 m), so it is a strong inference, not a field in the run.

---

## 4. Drainage inventories (GeoJSON)

`GET /drainage/{layer}.geojson` — WGS84, `application/geo+json`.

| Layer | Contents |
|---|---|
| `drain_network` | Conduit centrelines |
| `trunk_legs` | Trunk drains |
| `sewer_network` | Recorded sewer mains (~1,980 km) |
| `outfalls` | Discharge points |
| `discharge_points` | Secondary discharges |
| `manholes_progression` | Manholes |
| `backflow_nodes` | Backflow-prone nodes |
| `pumps` | Storm pumps |
| `inlets_rim` | Side-entry pits |
| `drain_work_status` | Municipal works status |

Also `GET /drainage/hydrograph.json`, `GET /Gurugram_wards.geojson` (MCG ward
boundaries) and `GET /Gurugram_district.geojson` (the district outline). Both are
CRS84 — `[lng, lat]`, standard GeoJSON order — and need no coordinate fixing.

---

## 5. Derived and third-party endpoints

### `GET /api/assets` — critical facilities · scope `assets` · **billed**

Hospitals, schools, colleges, fire stations, police stations, pharmacies —
~1,300 across the city.

`?bbox=south,west,north,east` (default: the Gurugram service area).

```json
{
  "hospital": [
    { "id": "ChIJ…", "name": "Example Hospital",
      "lat": 28.4595, "lng": 77.0266, "address": "Sector 14, Gurugram" }
  ],
  "school": [], "college": [], "fire_station": [], "police": [], "pharmacy": []
}
```

> **Bbox handling.** Filling a cold bbox costs ~96 upstream Places calls, so
> requests are snapped to a ~0.01° grid and clipped to the Gurugram service
> area. Near-identical boxes therefore share one cached result — you cannot
> "miss" the cache by shifting a viewport slightly, and you will not be billed
> for it either. Outside the service area you get `bbox_outside_service_area`;
> larger than 0.6° gets `bbox_too_large`. **Prefer omitting `bbox` entirely**:
> the default is warmed at startup and always instant.

Results are cached 6 h and served stale-while-revalidate, so this endpoint never
blocks on Google.

### `GET /api/locality?pts=lat,lng;lat,lng` — reverse geocode · `geocode` · billed

Up to 24 points per call, resolved in parallel and cached.

```json
{ "results": [ { "lat": 28.4595, "lng": 77.0266, "name": "Sector 14, Gurugram" } ] }
```

An unresolvable point returns `"name": ""` rather than failing the batch.

### `GET /api/geocode/autocomplete?q=` — search · `geocode` · billed

Minimum 2 characters, biased 30 km around Gurugram. Cached 15 min.

```json
{ "suggestions": [
  { "placeId": "ChIJ…", "main": "Sector 56",
    "secondary": "Gurugram, Haryana", "description": "Sector 56, Gurugram" } ] }
```

### `GET /api/geocode/place?id=` — resolve a `placeId` · `geocode` · billed

Cached 7 days.

```json
{ "lat": 28.4211, "lng": 77.0836, "name": "Sector 56", "address": "Sector 56, Gurugram, Haryana" }
```

### `GET /api/route?pts=lng,lat;lng,lat` — driving route · `route` · billed

Exactly two waypoints. Returns the Mappls `route_adv` response unchanged
(GeoJSON geometry, full overview).

### `GET /api/config` — map SDK key · scope `config`

```json
{ "mapplsApiKey": "…" }
```

Returns **our** Mappls key for the console to load the basemap. A map SDK key is
necessarily visible to the browser that uses it; if you have been given this
scope, its quota is ours and its referrer allowlist must include your domains.
Supply your own key instead and you can skip this endpoint entirely.

### `GET /api/live-forecast/status` — forecast freshness

Public; no key required.

```json
{ "built": { "run_id": "…", "base_valid_time": "…", "time_step_min": 10.0, "n_hours": 145 },
  "upstream": { "run_id": "…", "frame_count": 145, "status": "ready" },
  "stale": false, "building": false, "server_time": "…" }
```

`stale: true` means a newer run exists upstream but is not transcoded yet. Poll
at most every 5 minutes — it is cached at that interval.

### `GET /api/live-forecast/latest` — run metadata · scope `live`

Full upstream run record including per-frame statistics.

---

## 6. Usage and quota reporting

### `GET /api/usage`

Describes **the key that made the request**. No scope required, never rate
limited, never billed — you cannot be throttled out of discovering that you are
throttled. `?days=N` sets the history window (1–90, default 30).

```json
{
  "key": {
    "id": "partner-a1b2c3",
    "name": "Partner Name",
    "scopes": ["sim", "drainage", "assets", "geocode"],
    "created": "2026-08-13T10:00:00+0530"
  },
  "limits": {
    "rate_per_min": 600,
    "daily_billed_quota": 2000,
    "billed_scopes": ["assets", "geocode", "route"]
  },
  "today": {
    "date": "2026-08-13",
    "calls": 1284,
    "billed_calls": 137,
    "bytes": 48213904,
    "quota_remaining": 1863,
    "quota_exhausted": false,
    "resets_at": "2026-08-14T00:00:00Z",
    "by_scope": {
      "sim":      { "calls": 1100, "bytes": 47000000, "errors": 0, "billed": false },
      "drainage": { "calls": 47,   "bytes": 1200000,  "errors": 0, "billed": false },
      "assets":   { "calls": 12,   "bytes": 13904,    "errors": 0, "billed": true },
      "geocode":  { "calls": 125,  "bytes": 0,        "errors": 2, "billed": true }
    }
  },
  "history": [
    { "date": "2026-08-13", "calls": 1284, "billed_calls": 137, "bytes": 48213904 }
  ],
  "server_time": "2026-08-13T06:35:17Z"
}
```

Notes for reconciliation:

* **Counts are exact across our worker processes** — one shared counter, not a
  per-process estimate.
* Only `billed_calls` consumes `daily_billed_quota`. Bulk data transfer does not.
* A request that fails (4xx/5xx) is **recorded but not billed**, so a scope
  misconfiguration shows up in `errors` without costing you quota.
* A cache hit on a billed endpoint is still one billed call to you; it simply
  costs us nothing upstream. Cache aggressively on your side if that matters.
* The day boundary is **UTC**, not IST.
* `quota_remaining` is `null` when the key is unmetered.

Poll it as often as you like — hourly is plenty for dashboards.

---

## 7. Limits

| | |
|---|---|
| Rate | Token bucket, `rate_per_min` from `/api/usage`. Burst-tolerant: a console cold load is ~40 requests in a few seconds and will not trip it. |
| Daily quota | Billed scopes only. Resets at UTC midnight. |
| Bbox | `/api/assets` only; snapped and clipped as described above. |
| Request size | 1 MB (nothing here accepts an upload). |

On `429`, honour `Retry-After`. Rate limits are enforced per worker process, so
the effective ceiling may be slightly above the stated figure — never below it.

---

## 8. Getting started

Check your key and see your scopes before writing any code:

```bash
node examples/preflight.mjs --key ft_live_… --upstream https://<host>
```

Then a minimal end-to-end pull:

```bash
curl -sH "X-FloodTwin-Key: $KEY" "$BASE/sim/manifest.json" | jq .
curl -sH "X-FloodTwin-Key: $KEY" "$BASE/api/usage" | jq .today
curl -sH "X-FloodTwin-Key: $KEY" -o grid00.bin "$BASE/sim/surface_grid_00.bin"
```

Sample payloads for developing against without burning quota are in
[`examples/sample-data/`](./examples/sample-data).

Questions, a scope you need, or a limit raised: contact AIResQ ClimSols.
