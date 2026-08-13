# FloodTwin embed starter

A complete working embed: the proxy that holds your key, and the console
rendered inside a host application. One command, one process.

Use it to confirm your key works end-to-end **before** touching your own
codebase — then copy the two pieces you need (`vite.config.js`'s proxy mount and
`src/App.jsx`'s component) into your real app.

## Run it

```bash
export FLOODTWIN_API_KEY=ft_live_…            # the key AIResQ issued you
export FLOODTWIN_UPSTREAM=https://…           # the FloodTwin base URL
export VITE_MAPPLS_KEY=…                      # your own Mappls SDK key

npm install
npm run preflight     # checks the key before you spend time on the UI
npm run dev           # opens http://localhost:5174
```

`npm run preflight` is the one to run first. It reports whether the host is
reachable, whether the key is accepted, which scopes it carries and whether
caching is working — each with a note on what to change if not.

## What you should see

A dark host-app strip across the top with **"Your application"**, and the
FloodTwin console filling everything below it: a map of Gurugram, the feature
panel on the left, the timeline, and the depth legend.

Press play on the timeline and the flood sheet moves through the storm. Switch
on **Drainage network (3D)** in the panel and ~140,000 conduits appear under the
streets — that one is the heaviest load, so it takes a few seconds.

In the browser console, `__demoTwin.jumpToDeepest()` flies the camera to the
deepest water in the current frame.

## The two things worth reading

**`vite.config.js`** — the proxy. Your key is read from `process.env` in the Node
process and attached to each upstream request. It is never exposed to the
browser. Note it is deliberately *not* `import.meta.env`/`VITE_*`: that prefix
inlines values into the client bundle.

**`src/App.jsx`** — the component. `baseUrl="/api/floodtwin"` points at your own
origin, and the console's parent has an explicit height. Those are the only two
things an integration has to get right.

## If something is wrong

| You see | Cause |
|---|---|
| Vite refuses to start with a message about env vars | `FLOODTWIN_API_KEY` / `FLOODTWIN_UPSTREAM` not exported. |
| Blank white area where the console should be | The console's parent has no height. See the `flex: 1; minHeight: 0` wrapper. |
| "Could not start" with a 401 | Key rejected — run `npm run preflight`. |
| Map never appears, SDK error in the console | `VITE_MAPPLS_KEY` missing, or restricted to a different referrer. |
| Feature switches on but stays empty | Your key lacks that scope. `npm run preflight` lists them. |

Full reference: [`../../INTEGRATION.md`](../../INTEGRATION.md).
