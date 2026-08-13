# Integrating FloodTwin

This is the guide for a partner embedding the FloodTwin console in their own
React application. It covers the key you were issued, the proxy you need to
stand up, and the component you mount.

Read the first section even if you skim the rest — the key model is the part
integrations most often get wrong, and getting it wrong means shipping a
credential to every visitor.

> **Calling the API from your own backend** rather than (or as well as) embedding
> the console? See **[API.md](./API.md)** — every endpoint, the binary formats,
> and usage/quota reporting.

---

## 1. Your key is a server-side secret

You were issued a key that looks like `ft_live_…`. It is a **password for your
backend**, not a public token.

**It must never reach a browser.** Not in `NEXT_PUBLIC_*`, not in `VITE_*`, not
in a config JSON your app fetches, not in the component's props. Anything a
browser can read, a visitor can copy — and your key carries your rate limit and
your daily quota on the billed endpoints.

So the request path is:

```
  your React app  ──►  your server  ──►  FloodTwin
   (no key)            (adds the key)     (verifies, scopes, meters)
```

Your server is the only thing that holds the key. That is also why there is no
CORS setup in this guide: the browser only ever talks to your own origin.

Store it the way you store a database password — environment variable or secret
manager, never in the repository.

If it leaks, tell us and we will revoke it and issue another. Revocation takes
effect on the next request.

### What your key is allowed to do

Keys carry **scopes**. Yours may not include all of them:

| Scope      | Covers                                            | Notes |
|------------|---------------------------------------------------|-------|
| `sim`      | `/sim/*`, `/live/*`, the ward/district GeoJSON    | The simulation itself. Required. |
| `drainage` | `/drainage/*`                                     | Pipe network + inventories. |
| `config`   | `/api/config`                                     | Only needed if you use our Mappls key. |
| `assets`   | `/api/assets`                                     | **Billed** — Google Places. |
| `geocode`  | `/api/geocode/*`, `/api/locality`                 | **Billed** — search + hotspot names. |
| `route`    | `/api/route`                                      | **Billed** — Mappls routing. |
| `live`     | `/api/live-forecast/*`                            | Forecast run metadata. |

A request outside your scopes returns **403** with a body naming what it wanted:

```json
{ "error": "scope_denied", "scope": "assets", "granted": ["sim", "drainage"] }
```

The console degrades rather than breaks when a scope is missing — without
`geocode`, hotspots show coordinates instead of locality names; without
`assets`, the critical-assets layer stays empty. If you need a scope you do not
have, ask; it is a one-line change on our side.

### Limits

* **Rate:** a per-minute token bucket, burst-tolerant. A cold console load is
  legitimately ~40 requests in a few seconds and will not trip it.
* **Daily quota:** applies only to the billed scopes above. Exceeding it returns
  **429** with `Retry-After` set to the seconds remaining until UTC midnight.

Both return JSON, never HTML, so your proxy can pass them straight through.

---

## 2. Stand up the proxy

Copy one of the reference handlers in [`examples/`](./examples):

* [`examples/express-proxy.mjs`](./examples/express-proxy.mjs) — Express.
* [`examples/nextjs-route.ts`](./examples/nextjs-route.ts) — Next.js App Router,
  save as `app/api/floodtwin/[...path]/route.ts`.

They are ~90 lines and deliberately do three things a hand-rolled proxy usually
misses:

1. **They stream.** A cold load pulls ~15 MB of simulation binaries, and the
   drainage network alone is 2.4 MB of geometry. Buffering those into memory
   before replying costs a copy of every byte per concurrent viewer.
2. **They forward `If-None-Match` / `If-Modified-Since`.** FloodTwin serves the
   heavy files with validators, so a repeat visit is a `304` with no body. Drop
   those headers and every reload re-downloads everything. This is the single
   most common reason an integration feels slow.
3. **They allowlist paths.** Your proxy should forward the FloodTwin surface and
   nothing else, so it cannot be used as an open relay.

Express:

```js
import express from 'express';
import { floodtwinProxy } from '@airesq/floodtwin-react/examples/express-proxy.mjs';

const app = express();
app.use('/api/floodtwin', floodtwinProxy({
  key: process.env.FLOODTWIN_API_KEY,        // server-side only
  upstream: 'https://twin.floodresq.com',
}));
```

The paths you must forward are exported as `FLOODTWIN_PATHS`, so you can assert
in your own tests that your proxy covers them:

```js
import { FLOODTWIN_PATHS } from '@airesq/floodtwin-react';
```

---

## 3. Mount the console

```bash
npm install @airesq/floodtwin-react
```

React 18+ is a peer dependency.

```jsx
import { FloodTwinConsole } from '@airesq/floodtwin-react';
import '@airesq/floodtwin-react/styles.css';

export default function FloodPage() {
  return (
    <div style={{ height: '80vh' }}>
      <FloodTwinConsole
        baseUrl="/api/floodtwin"          // YOUR proxy, not our host
        mapplsApiKey={process.env.NEXT_PUBLIC_MAPPLS_KEY}
      />
    </div>
  );
}
```

That is the whole integration. The console arrives with its own feature panel,
timeline and legends; each layer fetches its own data lazily through `baseUrl`
the first time you switch it on, so a first paint costs the map, one manifest
and one depth grid — not the whole 15 MB.

### Sizing

`.ft-root` is `height: 100%` with a `min-height: 420px` floor. **Give the
container an explicit height** — the usual "nothing rendered" report is a parent
with auto height.

### The Mappls key

**You do not need one.** If your key carries the `config` scope — check with
`node examples/preflight.mjs` — the console fetches AIResQ's Mappls key through
your proxy and loads the basemap with it. The map and places quota is theirs.

Two consequences worth knowing:

* **Tell AIResQ your domains.** That key is referrer-restricted, so your origins
  — production *and* every staging/preview domain — must be on its allowlist.
  Until they are, the map silently fails to load and it looks like a broken SDK
  rather than a permissions problem. This is the most common first-day issue.
* A map SDK key is visible in the browser that uses it, by design (it is in the
  script URL). That is true of every Mappls integration including AIResQ's own.

If you would rather use your own key — to avoid the referrer coordination, or
because you already have Mappls billing — pass it and the fallback is skipped
entirely:

```jsx
<FloodTwinConsole baseUrl="/api/floodtwin" mapplsApiKey={YOUR_KEY} />
```

### Watching your quota

`/api/assets`, `/api/geocode/*` and `/api/route` draw on AIResQ's Google and
Mappls quota and count against a daily limit on your key. `GET /api/usage`
reports consumption, limits and what is left — see [API.md §6](./API.md#6-usage-and-quota-reporting).
It is never rate-limited or billed, so poll it freely.

---

## 4. Driving it from your own UI

The console is self-contained, but you can read and steer it.

`onReady` hands you a live handle:

```jsx
<FloodTwinConsole
  baseUrl="/api/floodtwin"
  onReady={(twin) => {
    twin.flyTo(77.0266, 28.4595, 16);
    twin.jumpToDeepest();
    console.log('depth here:', twin.depthAt(77.03, 28.46));
  }}
/>
```

`useFloodTwin()` reads state from anywhere inside the console:

```jsx
import { useFloodTwin } from '@airesq/floodtwin-react';

function MyStatusBar() {
  const { kpi, step, totalSteps, setStep, toggleFeature } = useFloodTwin();
  return (
    <div>
      {kpi?.wetKm2.toFixed(1)} km² inundated · hour {step}/{totalSteps}
      <button onClick={() => setStep(step + 1)}>Next hour</button>
      <button onClick={() => toggleFeature('drainage')}>Pipes</button>
    </div>
  );
}
```

Initial state comes from props — `features` merges over the defaults, so you
name only what you want to change:

```jsx
<FloodTwinConsole
  baseUrl="/api/floodtwin"
  dataset="live"                  // 'event' (09 Jul 2025) | 'live' (daily forecast)
  features={{ drainage: true, buildings: false }}
  brand={false}                   // drop our masthead inside your own chrome
  className="my-console"
/>
```

The feature catalogue is exported as data (`FEATURES`, `GROUPS`) if you want to
render your own toggle UI against the same ids.

### Composing your own layout

For full control, mount the pieces yourself. `MapCanvas` is the one that boots
the engine and must be present:

```jsx
import {
  FloodTwinProvider, MapCanvas, LayersPanel, TimeControl,
  createTwinStore, createClient,
} from '@airesq/floodtwin-react';

const store = createTwinStore({ features: { drainage: true } });
const client = createClient({ baseUrl: '/api/floodtwin' });

<FloodTwinProvider store={store} client={client}>
  <div className="ft-root my-layout">
    <MapCanvas />
    <aside><TimeControl /><LayersPanel /></aside>
  </div>
</FloodTwinProvider>
```

Keep the `ft-root` class on a wrapper — every packaged style is scoped under it.

---

## 5. Notes and gotchas

**Styles are scoped.** Every rule ships nested under `.ft-root`, so the console
cannot restyle your page and your CSS will not leak into it. The consequence:
the wrapper element must carry that class. `<FloodTwinConsole>` adds it for you.

**More than one console on a page works.** Each mount gets its own store, map and
data cache. They do not share a timeline and do not hear each other's clicks.

**`baseUrl` is read once per mount.** Changing it later is ignored by design —
the engine and its caches are built around it. To repoint a live console, remount
it with `key={baseUrl}`.

**Bundle size.** three.js (~600 KB raw, ~154 KB gzipped) loads only when a 3-D
feature is first switched on, because every heavy feature is a dynamic import.
Keep those split points intact — bundling the package into a single chunk makes
every visitor download the renderer to look at a flat map.

**Server-rendering.** The component renders on the server (you get the shell and
the boot overlay); the engine only starts in the browser. No `ssr: false` needed,
though `next/dynamic` with `ssr: false` is fine too.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401 key_required` | Your proxy is not attaching `X-FloodTwin-Key`, or `baseUrl` points straight at FloodTwin instead of your proxy. |
| `401 invalid_key` | Key is wrong, mistyped, or revoked. |
| `403 scope_denied` | Your key lacks that scope — the body names it. |
| `429 rate_limited` | Bursting past your per-minute limit; `Retry-After` says how long. |
| `429 quota_exceeded` | Daily billed-endpoint quota spent; resets at UTC midnight. |
| Blank area, no errors | Container has no height. See **Sizing**. |
| Map never appears, console logs an SDK error | Mappls key missing, or restricted to a referrer that is not your domain. |
| Styles look wrong | `styles.css` not imported, or the wrapper lost its `ft-root` class. |
| Everything re-downloads on reload | Your proxy is dropping `ETag` / `If-None-Match`. |
| Console crashes the proxy on first binary | Your proxy aborts its own stream on response `close` — see the `writableFinished` guard in the reference handler. |
