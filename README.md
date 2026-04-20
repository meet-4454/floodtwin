# FloodTwin — 3D Immersive Flood Visualization Engine

FloodTwin is a real-time 3D flood visualization engine built for Delhi/NCR. It renders 336 timesteps of hydrological simulation data (14 days at 5-minute intervals) as a physically-realistic, animated water surface on an interactive 3D map.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Full Workflow — End to End](#full-workflow--end-to-end)
3. [Backend: Flask Data Server](#backend-flask-data-server)
4. [Frontend Architecture](#frontend-architecture)
5. [Realistic Water Animation — Deep Dive](#realistic-water-animation--deep-dive)
   - [The Core Problem](#the-core-problem)
   - [Step 1: Polygon-to-Texel Mapping](#step-1-polygon-to-texel-mapping)
   - [Step 2: Depth Texture Construction](#step-2-depth-texture-construction)
   - [Step 3: Vertex Shader — Wave Geometry](#step-3-vertex-shader--wave-geometry)
   - [Step 4: Fragment Shader — Surface Appearance](#step-4-fragment-shader--surface-appearance)
   - [Step 5: The Animation Loop](#step-5-the-animation-loop)
6. [Binary Data Architecture](#binary-data-architecture)
7. [Map Integration (Mappls / MapLibre GL)](#map-integration-mappls--maplibre-gl)
8. [UI Features](#ui-features)
9. [Setup & Running](#setup--running)
10. [Dependencies](#dependencies)
11. [Configuration](#configuration)

---

## Project Overview

| Property | Value |
|---|---|
| Region | Delhi/NCR (28.4595°N, 77.0266°E) |
| Simulation start | 2025-07-09 01:55:00 |
| Total timesteps | 336 (14 days × 288 steps/day at 5-min intervals) |
| Polygon count | 3,000+ flood-zone polygons |
| Depth texture resolution | 512 × 512 texels |
| Water mesh subdivisions | 384 × 384 segments |
| Max simulated depth | 3.0 meters |
| Data volume | ~101 MB (34 binary chunk files) |

---

## Full Workflow — End to End

```
Hydrological Simulation Data (offline)
          │
          ▼
  ┌─────────────────────────────────────┐
  │  Pre-processing (offline pipeline)  │
  │  - Convert polygon geometries       │
  │    to coordinates.bin (6.3 MB)      │
  │  - Build polygon_index.json (3 MB)  │
  │    with byte offsets per polygon    │
  │  - Chunk simulation depths into     │
  │    34 binary files (chunk_000.bin   │
  │    → chunk_033.bin, 101 MB total)   │
  │    Each file = 10 timesteps         │
  └─────────────────────────────────────┘
          │
          ▼
  ┌──────────────────────────────────────┐
  │  Flask Server (server.py, port 9121) │
  │  - Serves index.html with API key   │
  │  - Streams binary data on demand    │
  │  - Path-traversal-safe chunk router │
  │  - 1-week Cache-Control headers     │
  └──────────────────────────────────────┘
          │  HTTP GET
          ▼
  ┌──────────────────────────────────────────────────┐
  │  Browser — app.js boots (928 lines)              │
  │                                                  │
  │  1. Fetch polygon_index.json                     │
  │     → metadata: offset, points per polygon       │
  │                                                  │
  │  2. Fetch coordinates.bin                        │
  │     → buildPolygonRings()                        │
  │     → Float64 lat/lng rings for all polygons     │
  │                                                  │
  │  3. Init Mappls map (3D, pitch=60°)              │
  │     → on 'load': register custom WebGL layer     │
  │                                                  │
  │  4. buildPolygonTexelMap()                       │
  │     → centroid of each polygon                   │
  │     → map centroid → texel index in 512×512 grid │
  │                                                  │
  │  5. buildWaterSurfaceMesh()                      │
  │     → THREE.PlaneGeometry(384×384 segments)      │
  │     → Custom ShaderMaterial with GLSL shaders    │
  │     → Add to THREE.Scene                         │
  │                                                  │
  │  6. loadChunk(0) → chunk_000.bin                 │
  │     → Float32Array[polygonCount × 10]            │
  │                                                  │
  │  7. updateStep(0)                                │
  │     → getDepth(0) from loaded chunk              │
  │     → updateDepthTexture(depths)                 │
  │     → depthGrid[512×512] filled                  │
  │     → THREE.DataTexture.needsUpdate = true       │
  │                                                  │
  │  8. Per-frame animation loop:                    │
  │     animClock += 0.016                           │
  │     uTime uniform updated                        │
  │     renderer.render(scene, camera)               │
  │     → Vertex shader animates wave geometry       │
  │     → Fragment shader computes water appearance  │
  └──────────────────────────────────────────────────┘
```

---

## Backend: Flask Data Server

**File:** [server.py](server.py)

The backend is intentionally minimal — it is a pure data server with no business logic.

### Routes

| Route | Purpose |
|---|---|
| `GET /` | Renders `index.html` with `{{ mappls_api_key }}` injected |
| `GET /polygon_index.json` | Returns polygon metadata (offset, point count, size) |
| `GET /coordinates.bin` | Binary float64 lat/lng geometry for all 3000+ polygons |
| `GET /chunks/<filename>` | Timestep depth data (chunk_000.bin → chunk_033.bin) |
| `GET /healthz` | Health check — returns `{"status":"ok"}` |

### Caching Strategy

All static assets are served with `Cache-Control: public, max-age=604800` (one week). This means the 101 MB chunk data is downloaded only once per browser session, drastically reducing re-render latency when stepping back through time.

### Security

The chunk endpoint rejects any filename containing `/` or `\` to prevent path traversal attacks. Filenames must match the pattern `chunk_NNN.bin` where NNN is a zero-padded 3-digit integer.

---

## Frontend Architecture

**File:** [static/js/app.js](static/js/app.js)

The entire visualization runs in one self-executing function. No build toolchain, no bundler. Key globals used:

```javascript
const CFG = window.FLOODTWIN_CONFIG  // Injected from Flask template
const CHUNK_SIZE = 10                // Timesteps per binary chunk file
const TOTAL_STEPS = 336              // Total simulation timesteps
const GRID_W = 512, GRID_H = 512    // Depth texture resolution
const PLANE_SEG = 384                // Water mesh subdivision count
const DEPTH_MAX = 3.0               // Max depth in meters (for normalization)
```

### Module Responsibilities

| Section | Responsibility |
|---|---|
| `VERT_SRC` / `FRAG_SRC` | GLSL shader strings (wave geometry + surface shading) |
| `buildPolygonRings()` | Parse `coordinates.bin` → polygon coordinate arrays |
| `buildPolygonTexelMap()` | Map polygon centroids → 512×512 grid texel indices |
| `loadChunk(idx)` | Async fetch of `chunk_NNN.bin`, LRU cache (max 3 chunks) |
| `getDepth(step)` | Extract single timestep from cached chunk |
| `updateDepthTexture(depths)` | Fill `depthGrid` and push to GPU as DataTexture |
| `buildWaterSurfaceMesh()` | Construct Three.js plane with shader material |
| `animLoop()` | Per-frame: advance clock, render, sync camera |
| `updateStep(step)` | Orchestrate chunk load → texture update → UI refresh |
| `tryFloodHit(lat, lng)` | Point-in-polygon ray-cast → show depth popup |
| `loadAssets(category)` | Fetch OSM critical infrastructure via Overpass API |
| `takeScreenshot()` | Composite export with stats overlay using html2canvas |

---

## Realistic Water Animation — Deep Dive

This is the core innovation of FloodTwin. The challenge was rendering thousands of flood polygons (irregularly shaped, varying depth, changing over time) as a single coherent 3D water surface that looks physically plausible — all in real-time in a browser.

### The Core Problem

Standard GIS approaches render flood zones as flat 2D colored polygons. This conveys depth data numerically but gives no visceral sense of flooding severity. The goal was to make water look like water — with waves, reflections, caustics, and depth-dependent color — while still being driven by real hydrological simulation data.

The solution uses three connected systems:

1. A spatial mapping from polygon data to a GPU texture
2. A subdivided 3D mesh whose geometry is deformed by that texture on the GPU
3. GLSL shaders that simulate wave physics and optical water properties

---

### Step 1: Polygon-to-Texel Mapping

**Function:** `buildPolygonTexelMap()` in [static/js/app.js](static/js/app.js)

The simulation produces depth values per polygon (3,000+ irregular shapes). The GPU cannot work with irregular polygon lists efficiently — it needs a regular grid. The solution is to rasterize each polygon's centroid into a 512×512 texture (called the **depth texture** or `uDepthTex`).

**Process:**

```
For each polygon p in polygonRings[]:
  1. Compute centroid: average of all (x, z) vertex positions
     cx = mean(ring.x values)
     cz = mean(ring.z values)

  2. Normalize to [0, 1] over the full grid extent
     u = (cx - gridMinX) / (gridMaxX - gridMinX)
     v = (cz - gridMinZ) / (gridMaxZ - gridMinZ)

  3. Convert to texel index
     tx = floor(u × GRID_W)   // 0 to 511
     tz = floor(v × GRID_H)   // 0 to 511

  4. Store mapping
     polyToTexel[p] = tz × GRID_W + tx
```

Grid bounds are expanded by 2% padding on all sides to prevent edge clipping.

**Result:** An array `polyToTexel[]` that lets us instantly go from polygon index → flat texel index in O(1). This is precomputed once at startup.

---

### Step 2: Depth Texture Construction

**Function:** `updateDepthTexture(depths)` in [static/js/app.js](static/js/app.js)

Every time the user changes the timestep, `getDepth(step)` returns a `Float32Array` of depths (one value per polygon). This is converted to the 512×512 texture as follows:

```javascript
// Reset grid
depthGrid.fill(0)

// For every polygon that has non-zero depth:
for (let p = 0; p < depths.length; p++) {
  const d = depths[p]
  if (d > 0 && polyToTexel[p] !== undefined) {
    const idx = polyToTexel[p]
    // Take maximum depth if multiple polygons map to same texel
    if (d > depthGrid[idx]) depthGrid[idx] = d
  }
}

// Normalize to [0, 1] and write to RGBA texture
for (let i = 0; i < GRID_W * GRID_H; i++) {
  const normalized = Math.min(depthGrid[i] / DEPTH_MAX, 1.0)
  texData[i * 4]     = normalized * 255  // R channel = depth
  texData[i * 4 + 1] = 0
  texData[i * 4 + 2] = 0
  texData[i * 4 + 3] = 255
}

depthTexture.needsUpdate = true
```

The depth texture is a `THREE.DataTexture` of type `UnsignedByteType`, format `RGBAFormat`, size 512×512. The R channel encodes normalized depth (0 = dry, 255 = 3.0 m deep). This texture is uploaded to the GPU every frame the timestep changes.

**Why 512×512?** It gives ~0.26 km² per texel at Delhi scale — fine enough for neighborhood-level detail while keeping GPU memory at ~1 MB per texture.

---

### Step 3: Vertex Shader — Wave Geometry

**Source:** `VERT_SRC` constant in [static/js/app.js](static/js/app.js)

The water surface is a flat `THREE.PlaneGeometry` with 384×384 subdivisions (147,456 triangles). The vertex shader runs on the GPU for every vertex every frame and displaces vertices vertically to simulate waves.

```glsl
uniform sampler2D uDepthTex;   // 512×512 depth texture
uniform float uTime;           // Animation clock (seconds)
uniform float uWaveAmp;        // Wave amplitude multiplier (0.18)

varying vec2 vUv;
varying float vDepth;
varying vec3 vNormal;

void main() {
  vUv = uv;

  // Sample depth at this vertex's UV position
  float depth = texture2D(uDepthTex, uv).r;
  vDepth = depth;

  // No displacement where there is no water
  float presence = smoothstep(0.02, 0.15, depth);

  // Two-component wave: orthogonal wave vectors create interference pattern
  float wave1 = sin(uv.x * 40.0 + uTime * 1.8)
              * cos(uv.y * 35.0 + uTime * 1.3);

  float wave2 = sin(uv.x * 28.0 - uTime * 2.1 + 1.57)
              * cos(uv.y * 22.0 + uTime * 0.9);

  // Combined wave, scaled by depth (deeper = bigger waves)
  float wave = (wave1 * 0.6 + wave2 * 0.4) * uWaveAmp * depth * presence;

  // Apply displacement along Y axis (up)
  vec3 displaced = position;
  displaced.y += wave;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
```

**Wave Physics Explained:**

- **Two orthogonal wave trains** (`wave1`, `wave2`) interfere to produce a complex, non-repeating surface pattern. A single sine wave would look mechanical.
- **Different frequencies and speeds** (40/35 vs 28/22 spatial, 1.8/1.3 vs 2.1/0.9 temporal) prevent visible periodicity.
- **Phase offset of π/2 (1.57)** on wave2 ensures the two trains are always out of phase, creating realistic constructive/destructive interference.
- **`depth * presence` scaling** means deep water produces tall waves, shallow water is nearly flat, and dry areas show no displacement. `smoothstep(0.02, 0.15, depth)` creates a soft shoreline — waves fade out as depth approaches zero, preventing sharp geometric edges.

---

### Step 4: Fragment Shader — Surface Appearance

**Source:** `FRAG_SRC` constant in [static/js/app.js](static/js/app.js)

This is where the water gets its realistic look. The fragment shader runs for every pixel of the water surface and computes:

#### 4a. Smooth Depth Sampling (Anti-aliasing)

```glsl
// sampleSoft(): 9-tap Gaussian-weighted depth sample
// Prevents pixelated depth boundaries at polygon edges
float sampleSoft(sampler2D tex, vec2 uv) {
  vec2 ts = 1.0 / vec2(512.0, 512.0);  // Texel size
  float v = 0.0;
  v += texture2D(tex, uv).r * 0.36;                    // center (weight 4)
  v += texture2D(tex, uv + vec2( ts.x, 0)).r * 0.18;   // right
  v += texture2D(tex, uv + vec2(-ts.x, 0)).r * 0.18;   // left
  v += texture2D(tex, uv + vec2(0,  ts.y)).r * 0.18;   // up
  v += texture2D(tex, uv + vec2(0, -ts.y)).r * 0.18;   // down
  // ... corner taps at 0.025 each
  return v;
}
```

This blurs the depth boundaries at polygon edges, creating soft shorelines rather than stepped pixel boundaries.

#### 4b. Dynamic Normal Computation

Normals are computed analytically from the depth gradient — the same technique used in parallax bump mapping:

```glsl
// Sobel-style normal from depth gradient
vec2 ts = 1.0 / vec2(512.0);
float dR = sampleSoft(uDepthTex, vUv + vec2(ts.x, 0.0));
float dL = sampleSoft(uDepthTex, vUv - vec2(ts.x, 0.0));
float dU = sampleSoft(uDepthTex, vUv + vec2(0.0, ts.y));
float dD = sampleSoft(uDepthTex, vUv - vec2(0.0, ts.y));

// Gradient in X and Z → normal vector
vec3 norm = normalize(vec3(dL - dR, 0.08, dD - dU));
```

Edges of flooded areas will have strong gradients → steep normals → bright specular highlights, mimicking light reflecting off the edge of a water body.

#### 4c. Fractional Brownian Motion (FBM) for Caustics

Caustics are the rippling light patterns seen on the floor through water. They are simulated with layered noise:

```glsl
float fbm(vec2 p) {
  float val = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    val += amp * sin(p.x * (2.0 + float(i) * 1.7) + uTime * 0.8)
               * cos(p.y * (2.3 + float(i) * 1.3) - uTime * 0.6);
    p *= 2.1;        // Lacunarity: double spatial frequency each octave
    amp *= 0.5;      // Persistence: halve amplitude each octave
  }
  return val;
}

// Apply caustics scaled by depth (caustics only visible in shallow water)
float caustic = fbm(vUv * 18.0 + vec2(uTime * 0.3, uTime * 0.2));
caustic = caustic * 0.5 + 0.5;              // Remap [-1,1] → [0,1]
float causticStr = (1.0 - depth) * 0.4;    // Fade with depth
```

#### 4d. Fresnel Effect

Real water reflects more light at grazing angles (looking across the surface) and transmits more when looked at straight down. The Fresnel term approximates this:

```glsl
// View direction in eye space
vec3 viewDir = normalize(cameraPosition - vWorldPos);
float fresnel = pow(1.0 - max(dot(norm, viewDir), 0.0), 3.0);
// fresnel → 0 when viewing from above, 1 at grazing angles
```

#### 4e. Depth-Based Color Gradient

Water color changes from light cyan in shallows to deep navy in deep water. Four color stops are interpolated:

```glsl
vec3 shallowColor = vec3(0.53, 0.81, 0.92);   // Light blue (#87CEEB-ish)
vec3 midColor     = vec3(0.18, 0.55, 0.76);   // Sky blue
vec3 deepColor    = vec3(0.05, 0.27, 0.53);   // Ocean blue
vec3 abyssColor   = vec3(0.01, 0.09, 0.22);   // Abyss

vec3 waterColor;
if (depth < 0.33) {
  waterColor = mix(shallowColor, midColor, depth / 0.33);
} else if (depth < 0.66) {
  waterColor = mix(midColor, deepColor, (depth - 0.33) / 0.33);
} else {
  waterColor = mix(deepColor, abyssColor, (depth - 0.66) / 0.34);
}
```

#### 4f. Specular Highlights

Phong-style specular simulates sunlight reflecting off wave peaks:

```glsl
vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));  // Fixed sun direction
float spec = pow(max(dot(reflect(-lightDir, norm), viewDir), 0.0), 32.0);
float specStr = fresnel * 0.8 + 0.2;
waterColor += vec3(spec) * specStr;
```

#### 4g. Alpha Blending (Soft Shorelines)

The most important visual detail for realism — water fades out smoothly at its edges rather than cutting off abruptly:

```glsl
float alpha = smoothstep(0.02, 0.22, depth);
gl_FragColor = vec4(waterColor + causticContrib, alpha * 0.88);
```

`smoothstep(0.02, 0.22, depth)` means:
- depth < 0.02 (< 6 cm): fully transparent
- depth 0.02–0.22 (6–66 cm): smooth fade-in
- depth > 0.22 (> 66 cm): 88% opaque (never fully opaque — water is translucent)

---

### Step 5: The Animation Loop

**Function:** `animLoop()` in [static/js/app.js](static/js/app.js)

```javascript
function animLoop() {
  requestAnimationFrame(animLoop)

  animClock += 0.016          // ~60 fps, 16ms per frame

  if (waterMaterial) {
    waterMaterial.uniforms.uTime.value = animClock
  }

  if (renderer && scene && camera) {
    // Sync Three.js camera with Mappls map camera
    syncCamera()

    // Render the Three.js scene into the custom WebGL layer
    renderer.render(scene, camera)
  }
}
```

The `animClock` increments every frame and drives all time-varying shader behavior:
- Wave positions (vertex shader): `sin(... + uTime * speed)`
- Caustic patterns (fragment shader): `fbm(... + vec2(uTime * 0.3, ...))`
- FBM animation: time offsets in each octave

The camera sync is what makes the 3D water appear correctly anchored to the map. Every frame, the Three.js projection and view matrices are rebuilt from the Mappls map's current Mercator projection state.

---

## Binary Data Architecture

### coordinates.bin (6.3 MB)

Flat binary file containing all polygon vertex data. Parsed by `buildPolygonRings()`:

```
[uint32: pointCount] [float64: lng_0] [float64: lat_0] [float64: lng_1] ...
[uint32: pointCount] [float64: lng_0] [float64: lat_0] ...
...  (repeated for all 3000+ polygons)
```

Each polygon is read by seeking to its byte offset (from `polygon_index.json`) and reading `pointCount * 2 * 8` bytes.

### polygon_index.json (3.0 MB)

Array of objects providing random-access metadata:

```json
[
  { "offset": 0,    "points": 47,  "size": 376  },
  { "offset": 376,  "points": 23,  "size": 184  },
  ...
]
```

This allows `O(1)` polygon lookup by index — crucial for the click-to-inspect feature.

### chunks/ (101 MB, 34 files)

Each file encodes 10 timesteps of depth data for all polygons:

```
chunk_NNN.bin = Float32Array[ polygonCount × 10 ]

Layout: [poly_0_step_0, poly_0_step_1, ..., poly_0_step_9,
         poly_1_step_0, ..., poly_1_step_9,
         ...]
```

**Chunk selection logic:**
```javascript
const chunkIdx = Math.floor(step / CHUNK_SIZE)       // Which file
const stepInChunk = step % CHUNK_SIZE                 // Offset within file
const offset = polygonIdx * CHUNK_SIZE + stepInChunk  // Float32 index
```

**LRU Cache:** At most 3 chunks are kept in memory (`MAX_CACHED = 3`). When a 4th chunk is loaded, the least recently used is evicted. Pre-fetching triggers when the user is within 2 steps of a chunk boundary.

---

## Map Integration (Mappls / MapLibre GL)

The Mappls Map SDK (based on MapLibre GL) provides the base map tiles and WebGL context. FloodTwin hooks into this via a **custom layer**:

```javascript
map.addLayer({
  id: 'water-surface',
  type: 'custom',
  renderingMode: '3d',

  onAdd(map, gl) {
    // Share the map's WebGL context with Three.js
    renderer = new THREE.WebGLRenderer({ context: gl, antialias: true })
    renderer.autoClear = false

    buildWaterSurfaceMesh()
    animLoop()
  },

  render(gl, matrix) {
    // Called every map repaint
    syncCamera(matrix)
  }
})
```

**Coordinate System:**

Map coordinates (WGS84 lat/lng) are converted to the Mercator coordinate space that MapLibre uses internally, then to local Three.js units:

```javascript
function lngLatToLocal(lng, lat) {
  // Use map.project() to get pixel coords at current zoom
  const pt = map.project([lng, lat])
  return {
    x: (pt.x - originPx.x) * metersPerPixel,
    z: (pt.y - originPx.y) * metersPerPixel
  }
}
```

The reference origin (`REF_LAT`, `REF_LNG`) is the center of the simulation area. All polygon vertices and the water plane are positioned relative to this origin so the Three.js scene stays numerically stable (no floating-point precision issues at global coordinates).

---

## UI Features

### Time Navigation

- **Slider:** Direct seek to any of 336 steps
- **Playback buttons:** Reset | Previous | Play/Pause | Next
- **Speed control:** 0.5×, 1×, 2×, 4× (configurable `setInterval` interval)
- **Live timestamp:** `DD-MMMM-YYYY HH:MM:SS` computed from step index

### Flood Inspector (Click-to-Query)

Click anywhere on the map → `tryFloodHit(lat, lng)` runs a point-in-polygon test using ray casting (Jordan curve theorem implementation). If inside a flooded polygon, shows a popup with:
- Water depth in meters
- Severity badge: Low / Moderate / High / Severe
- Geographic coordinates
- Current simulation timestamp

Severity thresholds:

| Label | Depth Range | Color |
|---|---|---|
| Low | 0 – 0.5 m | Light cyan `#0e7490` |
| Moderate | 0.5 – 1.0 m | Sky blue `#0369a1` |
| High | 1.0 – 2.0 m | Dark blue `#155e75` |
| Severe | > 2.0 m | Navy on white `#264351` |

### Critical Assets Overlay

Fetches from OpenStreetMap Overpass API at runtime:
- Hospitals, schools, colleges, fire stations, police stations, pharmacies
- Each rendered as a colored marker with icon
- Clickable popup shows name and address
- Toggle visibility per category from the sidebar

### Screenshot / Export

Uses `html2canvas` to composite:
1. Map canvas (current 3D view)
2. Flood statistics card (polygon counts per severity)
3. Timestamp and simulation metadata
4. Depth legend
5. FloodTwin watermark

Exports as PNG or JPEG (`quality: 0.92`) with filename `floodtwin_DD-MMM-YYYY_HH-MM-SS.{fmt}`.

### 3D / 2D Toggle

Smoothly transitions the map pitch between 60° (3D perspective) and 0° (flat top-down). The water surface renders correctly in both modes because the camera sync runs every frame.

---

## Setup & Running

### Requirements

```
Python 3.9+
Flask >= 3.0, < 4.0
gunicorn >= 21.2
```

Install:
```bash
pip install -r requirements.txt
```

### Environment

Create a `.env` file:
```
MAPPLS_API_KEY=your_mappls_api_key_here
PORT=9121
FLASK_DEBUG=0
```

### Development

```bash
python server.py
# Listening on http://localhost:9121
```

### Production

```bash
gunicorn server:app --bind 0.0.0.0:9121 --workers 2
```

### Data Files Required

The following files must be present at the project root:

```
polygon_index.json    # 3.0 MB — polygon metadata
coordinates.bin       # 6.3 MB — polygon geometries
chunks/
  chunk_000.bin       # ~3 MB each
  chunk_001.bin
  ...
  chunk_033.bin       # 34 files total, ~101 MB
```

---

## Dependencies

### Backend

| Package | Version | Purpose |
|---|---|---|
| Flask | >= 3.0 | HTTP server, template rendering |
| gunicorn | >= 21.2 | Production WSGI server |

### Frontend (CDN, no npm required)

| Library | Version | Purpose |
|---|---|---|
| Three.js | r128 | 3D rendering, WebGL shaders, DataTexture |
| Mappls Map SDK | 3.0 | Map tiles, WebGL context, Mercator projection |
| html2canvas | 1.4.1 | Screenshot / export rendering |
| Nominatim (OSM) | API | Forward/reverse geocoding for search |
| Overpass API (OSM) | API | Critical infrastructure data |

---

## Configuration

All runtime configuration is injected from the Flask template into `window.FLOODTWIN_CONFIG`:

```javascript
window.FLOODTWIN_CONFIG = {
  mapplsApiKey: "{{ mappls_api_key }}",
  dataUrls: {
    polygonIndex: "/polygon_index.json",
    coordinates:  "/coordinates.bin",
    chunksBase:   "/chunks/"
  }
}
```

Key constants in [static/js/app.js](static/js/app.js) that can be tuned:

| Constant | Default | Effect |
|---|---|---|
| `PLANE_SEG` | 384 | Water mesh detail (higher = smoother waves, slower) |
| `GRID_W / GRID_H` | 512 | Depth texture resolution |
| `DEPTH_MAX` | 3.0 | Max depth in meters |
| `uWaveAmp` | 0.18 | Wave height multiplier |
| `MAX_CACHED` | 3 | Chunk LRU cache size |
| `CHUNK_SIZE` | 10 | Timesteps per binary chunk |

---

## Architecture Summary

```
                     ┌──────────────────────────────┐
User Browser         │         Mappls Map GL         │
                     │   (WebGL canvas, 3D tiles)    │
                     │                               │
                     │  ┌─────────────────────────┐  │
                     │  │   Custom Layer (Three.js)│  │
                     │  │                         │  │
                     │  │  PlaneGeometry 384×384  │  │
                     │  │  ┌───────────────────┐  │  │
                     │  │  │ ShaderMaterial    │  │  │
                     │  │  │ ┌─────────────┐  │  │  │
                     │  │  │ │ Vert Shader │  │  │  │
                     │  │  │ │  wave disp  │  │  │  │
                     │  │  │ └─────────────┘  │  │  │
                     │  │  │ ┌─────────────┐  │  │  │
                     │  │  │ │ Frag Shader │  │  │  │
                     │  │  │ │  depth color│  │  │  │
                     │  │  │ │  fresnel    │  │  │  │
                     │  │  │ │  caustics   │  │  │  │
                     │  │  │ │  specular   │  │  │  │
                     │  │  │ └─────────────┘  │  │  │
                     │  │  └───────────────────┘  │  │
                     │  │                         │  │
                     │  │  DataTexture 512×512     │  │
                     │  │  (depth grid, R channel) │  │
                     │  └─────────────────────────┘  │
                     └──────────────────────────────┘
                                   ▲
                                   │ updateDepthTexture()
                                   │
              ┌────────────────────┴──────────────────────┐
              │                 app.js                    │
              │                                           │
              │  polygonRings[]   polyToTexel[]           │
              │  chunk cache (LRU, max 3)                 │
              │  animClock (60 fps)                       │
              └────────────────────┬──────────────────────┘
                                   │ HTTP GET (cached)
                                   │
              ┌────────────────────┴──────────────────────┐
              │              server.py                    │
              │  Flask 3.x, port 9121                     │
              │  Serves binary chunks + static assets     │
              └───────────────────────────────────────────┘
```
