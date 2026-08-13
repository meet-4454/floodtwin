#!/usr/bin/env python3
"""Decode every FloodTwin binary format, end to end.

    pip install numpy requests
    FLOODTWIN_API_KEY=ft_live_… FLOODTWIN_UPSTREAM=https://… python decode.py

Runnable reference for API.md §3. It fetches one frame of each format, decodes
it, and prints figures you can sanity-check against the manifest — so if your
own decoder disagrees with this, the difference is in your code, not the spec.

Uses only the `sim` and `drainage` scopes; nothing here is billed.
"""
import os
import sys

try:
    import numpy as np
    import requests
except ImportError:
    sys.exit("pip install numpy requests")

BASE = os.environ.get("FLOODTWIN_UPSTREAM", "").rstrip("/")
KEY = os.environ.get("FLOODTWIN_API_KEY", "")
if not BASE or not KEY:
    sys.exit("Set FLOODTWIN_UPSTREAM and FLOODTWIN_API_KEY.")

H = {"X-FloodTwin-Key": KEY}
S = requests.Session()
S.headers.update(H)


def get(path: str) -> bytes:
    r = S.get(BASE + path, timeout=60)
    if not r.ok:
        sys.exit(f"{path} → {r.status_code} {r.text[:200]}")
    return r.content


# ── manifest ────────────────────────────────────────────────────────────────
man = S.get(f"{BASE}/sim/manifest.json", timeout=30).json()
nn, nl = man["n_nodes"], man["n_links"]
gn, dscale, fscale = man["grid_n"], man["depth_scale"], man["flow_scale"]
w, s, e, n_ = man["grid_bbox"]

print(f"\nmanifest — {man['n_hours']} frames, {nn:,} nodes, {nl:,} links")
print(f"           grid {gn}x{gn}, depth/{dscale:.0f}, flow/{fscale:.0f}")

# ── 1. surface depth grid ───────────────────────────────────────────────────
raw = get("/sim/surface_grid_00.bin")
assert len(raw) == gn * gn * 2, f"expected {gn*gn*2} bytes, got {len(raw)}"
depth = np.frombuffer(raw, "<u2").reshape(gn, gn) / dscale

wet = depth >= man["wet_threshold_m"]
# Cell size in metres, for area. Longitude degrees shrink with latitude.
mid = (s + n_) / 2
cw = (e - w) / (gn - 1) * 111_320 * np.cos(np.radians(mid))
ch = (n_ - s) / (gn - 1) * 110_540

print(f"\nsurface_grid_00  {len(raw):,} B")
print(f"  max depth      {depth.max():.3f} m")
print(f"  wet cells      {wet.sum():,} ({wet.mean()*100:.2f}%)")
print(f"  flooded area   {wet.sum() * cw * ch / 1e6:.2f} km²")

# Deepest point, back to lng/lat.
y, x = np.unravel_index(depth.argmax(), depth.shape)
print(f"  deepest at     {w + x/(gn-1)*(e-w):.5f}, {s + y/(gn-1)*(n_-s):.5f}")

# ── 2. drainage dynamics ────────────────────────────────────────────────────
mask_b = (nn + 7) // 8
raw = get("/sim/drain_dyn_00.bin")
expect = nn * 2 + mask_b + nl * 2
assert len(raw) == expect, f"expected {expect} bytes, got {len(raw)}"

node_depth = np.frombuffer(raw, "<u2", count=nn) / dscale
surcharge = np.unpackbits(
    np.frombuffer(raw, "u1", count=mask_b, offset=nn * 2),
    bitorder="little")[:nn].astype(bool)
flow = np.frombuffer(raw, "<i2", count=nl, offset=nn * 2 + mask_b) / fscale

print(f"\ndrain_dyn_00     {len(raw):,} B")
print(f"  node depth     max {node_depth.max():.3f} m, mean {node_depth.mean():.3f} m")
print(f"  surcharging    {surcharge.sum():,} nodes")
print(f"  flow           {flow.min():+.2f} … {flow.max():+.2f} m³/s")

# ── 3. geometry ─────────────────────────────────────────────────────────────
raw = get("/sim/drain_geom.bin")
assert len(raw) == nn * 8 + nl * 8, f"expected {nn*8 + nl*8} bytes, got {len(raw)}"
lonlat = np.frombuffer(raw, "<f4", count=nn * 2).reshape(nn, 2)
links = np.frombuffer(raw, "<u4", count=nl * 2, offset=nn * 8).reshape(nl, 2)

print(f"\ndrain_geom       {len(raw):,} B")
print(f"  node extent    {lonlat[:,0].min():.4f}..{lonlat[:,0].max():.4f} lng, "
      f"{lonlat[:,1].min():.4f}..{lonlat[:,1].max():.4f} lat")
assert links.max() < nn, "link references a node index out of range"
print(f"  link indices   valid (max {links.max():,} < {nn:,})")

# ── 4. static node / link attributes ────────────────────────────────────────
stat = np.frombuffer(get("/sim/drain_node_static.bin"), "<f4").reshape(nn, 3)
invert, max_depth, area = stat[:, 0], stat[:, 1], stat[:, 2]
peak = np.frombuffer(get("/sim/drain_link_static.bin"), "<f4")

print(f"\nstatic           nodes {stat.shape}, links {peak.shape}")
print(f"  invert level   {invert.min():.1f} … {invert.max():.1f} m")
print(f"  node capacity  mean {max_depth.mean():.2f} m")

# How full is the network right now? This is the "capacity view" the console
# renders: a conduit at 1.0 is running at its own peak for the run.
with np.errstate(divide="ignore", invalid="ignore"):
    util = np.where(peak > 0, np.abs(flow) / peak, 0.0)
print(f"  utilisation    mean {util.mean():.3f}, over 90%: {(util > 0.9).sum():,} conduits")

# ── 5. optional classification ──────────────────────────────────────────────
r = S.get(f"{BASE}/sim/drain_link_class.bin", timeout=60)
if r.ok:
    cls = np.frombuffer(r.content, "u1")
    names = {0: "storm", 1: "sewer", 2: "unclassified"}
    counts = {names[k]: int((cls == k).sum()) for k in names}
    print(f"\nlink_class       {counts}")
else:
    # Absence is not an error — treat every conduit as unclassified.
    print(f"\nlink_class       not published ({r.status_code}) — treat all as unclassified")

# ── 6. usage ────────────────────────────────────────────────────────────────
u = S.get(f"{BASE}/api/usage", timeout=30).json()
t = u["today"]
print(f"\nusage today      {t['calls']} calls, {t['billed_calls']} billed, "
      f"{t['bytes']/1e6:.1f} MB")
print(f"  quota          {t['quota_remaining']} left of "
      f"{u['limits']['daily_billed_quota']}, resets {t['resets_at']}")

print("\nAll formats decoded and self-consistent.\n")
