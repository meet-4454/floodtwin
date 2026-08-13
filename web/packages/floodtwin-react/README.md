# @airesq/floodtwin-react

The FloodTwin flood digital-twin console, as an embeddable React component.

A coupled 2-D surface + 1-D storm-drain simulation of Gurugram — 981,880 surface
triangles, 118,768 drainage nodes, 139,798 conduits — rendered in 3-D over a live
basemap, with the whole console's functionality in one component: the flood
sheet hour by hour, the buried pipe network filling and surcharging, road
passability, critical assets, ranked hotspots and the timeline.

```bash
npm install @airesq/floodtwin-react
```

```jsx
import { FloodTwinConsole } from '@airesq/floodtwin-react';
import '@airesq/floodtwin-react/styles.css';

<div style={{ height: '80vh' }}>
  <FloodTwinConsole baseUrl="/api/floodtwin" mapplsApiKey={YOUR_MAPPLS_KEY} />
</div>
```

**`baseUrl` points at your own server, not at FloodTwin.** Your FloodTwin key is
a server-side secret; your backend proxies these paths and attaches it. Reference
proxies for Express and Next.js are in [`examples/`](./examples), and the whole
setup takes about ten minutes.

→ **[INTEGRATION.md](./INTEGRATION.md)** — the key model, the proxy, the props,
and the troubleshooting table. Start there.

→ **[API.md](./API.md)** — the HTTP API underneath: endpoints, request/response
formats, the simulation binary layouts, and usage/quota reporting. For teams
whose backend calls FloodTwin directly.

→ **[examples/sample-data/](./examples/sample-data)** — real payloads and a
runnable decoder for every binary format.

## What you get

| | |
|---|---|
| **Surface flood** | Depth as a moving sheet, hour by hour, colour and height both following real depth. |
| **Drainage network (3-D)** | Every conduit at its true depth below the street, water standing at the solved level. Storm and foul sewers separated and switchable. |
| **Road passability** | Street network checked against the flood — amber where passable with care, red above 0.30 m. |
| **Critical assets** | ~1,300 hospitals, schools, fire and police stations, with the water depth at each door. |
| **Hotspots** | The worst-hit pockets, ranked and named by locality. |
| **Datasets** | The reconstructed 09 Jul 2025 event (133 mm / 12 h) and a daily 24 h-ahead forecast at 10-minute frames. |

Every feature is a lazy import, so a first paint costs the map, one manifest and
one depth grid — not the 15 MB the full dataset would be.

## API

```jsx
<FloodTwinConsole
  baseUrl="/api/floodtwin"      // your proxy path
  mapplsApiKey="…"              // your Mappls SDK key
  dataset="event"               // 'event' | 'live'
  features={{ drainage: true }} // merged over the defaults
  brand={false}                 // drop the masthead in your own chrome
  onReady={(twin) => twin.flyTo(77.0266, 28.4595, 16)}
/>
```

Also exported: `useFloodTwin()` to read and steer a mounted console;
`FloodTwinProvider` + `MapCanvas`, `LayersPanel`, `TimeControl`,
`HotspotsPanel`, `DepthLegend`, `KpiStrip` and friends to compose your own
layout; `FEATURES` / `GROUPS` as data for your own toggle UI; and
`FLOODTWIN_PATHS`, the path allowlist your proxy must forward.

TypeScript declarations are included.

## Requirements

* React 18 or newer (peer dependency)
* A FloodTwin API key, held server-side
* A WebGL-capable browser

## Licence

UNLICENSED — issued under agreement with AIResQ ClimSols.
