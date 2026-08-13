# Sample data

Real payloads captured from a live FloodTwin instance, so you can build against
the exact shapes before your key is wired up — and so you can diff against them
if something looks wrong later.

| File | What |
|---|---|
| `manifest.sim.json` | `/sim/manifest.json` — the 09 Jul 2025 event, complete |
| `manifest.live.json` | `/live/manifest.json` — daily forecast; `frames[]` cut to 3 of 145 |
| `outfalls.sample.geojson` | `/drainage/outfalls.geojson` — 3 of the features |
| `usage.json` | `/api/usage` — the reporting shape |
| `decode.py` | Runnable decoder for **every** binary format |

The binaries themselves are not included — `surface_grid_00.bin` alone is 1.1 MB
raw, and they are one authenticated GET away. `decode.py` fetches and decodes
them for you.

## decode.py

```bash
pip install numpy requests
FLOODTWIN_API_KEY=ft_live_… FLOODTWIN_UPSTREAM=https://… python decode.py
```

It reads the manifest, then decodes the depth grid, the per-frame drainage
state, the network geometry and the static attributes — asserting every buffer
length against the manifest as it goes. If your own decoder disagrees with it,
the difference is in your code.

Expected output, roughly:

```
manifest — 13 frames, 118,768 nodes, 139,798 links
           grid 768x768, depth/1000, flow/100

surface_grid_00  1,179,648 B
  max depth      1.413 m
  wet cells      32 (0.01%)
  flooded area   0.03 km²
  deepest at     77.01399, 28.46359

drain_dyn_00     531,978 B
  node depth     max 9.103 m, mean 0.380 m
  surcharging    419 nodes
  flow           -87.27 … +95.15 m³/s

drain_geom       2,068,528 B
  link indices   valid (max 118,767 < 118,768)

link_class       {'storm': 21910, 'sewer': 87606, 'unclassified': 30282}

All formats decoded and self-consistent.
```

Frame 0 is the **start of the storm**, so very little water is on the surface —
32 wet cells is correct, not a decoding failure. Step through to frame 6–8 for
the peak; `manifest.live.json`'s `frames[i].max_depth_m` gives the profile
without downloading anything.

Format reference: [`../../API.md`](../../API.md) §3.
