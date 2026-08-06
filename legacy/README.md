# Superseded vanilla front-end

These are the pre-React files, kept for reference only. Nothing in the running
app loads them — `floodtwin/routes/pages.py` serves the Vite bundle from
`static/dist`, and the source lives in `web/`.

| File | Replaced by |
|---|---|
| `app.js` (5,928 lines, one IIFE) | `web/src/engine/*` (renderer) + `web/src/components/*` (UI) |
| `drainage_viz.js` | `web/src/engine/drainageViz.js` |
| `index.html` (Jinja template) | `web/index.html` + `web/src/pages/*` |
| `styles.css` | `web/src/styles/*` (still present at `static/css/styles.css` too) |
| `road_worker.js` | folded into `web/src/engine/roadsLayer.js` (the grid lookup is O(1), so the worker is no longer needed) |

Delete this directory once you're happy with the rebuild.
