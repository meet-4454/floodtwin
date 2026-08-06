#!/usr/bin/env python3
"""Build the SEWERAGE network layer from the MCG/GMDA asset inventory.

Source (real, not synthetic)
---------------------------
`drainage/d_june_5_actual_storm_plus_sewer_segments.csv` — 141,821 Manning-verified
hydraulic segments compiled from MCG's own utility KMZ layers and GMDA records:
28,064 storm-water + 113,757 SEWER segments, upstream→downstream oriented, with
absolute inverts, FABDEM-derived slopes bounded to 0.0005–0.02, parsed diameters,
material, condition/desilting records and Manning full-flow capacities.

Only `network_type == "sewer"` is exported here: the storm-water side is already
rendered from the coupled 1D-2D run's own solved network, so duplicating it would
put two differently-derived storm networks on the same map.

What the script does
--------------------
Two-point segments are welded into polylines at shared endpoints (snapped on a
0.5 m grid in the source projection), split wherever the attributes change or a
junction appears, then simplified with Douglas–Peucker at ~1.5 m. That turns
113k stubs into a few tens of thousands of continuous mains, which is what makes
the layer both drawable and readable.

    python3 build_sewer_network.py
      → drainage/web/sewer_network.geojson
"""
from __future__ import annotations

import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).parent.resolve()
SRC = BASE / "drainage" / "d_june_5_actual_storm_plus_sewer_segments.csv"
OUT = BASE / "drainage" / "web" / "sewer_network.geojson"

SNAP_M = 0.5          # endpoint welding tolerance, source CRS metres
SIMPLIFY_DEG = 1.4e-5  # ≈1.5 m at Gurugram's latitude

csv.field_size_limit(1 << 24)


def fnum(v, default=None):
    try:
        f = float(v)
        return default if math.isnan(f) else f
    except (TypeError, ValueError):
        return default


def load_segments():
    """Read the sewer rows we can actually place on a map."""
    segs, skipped = [], 0
    with SRC.open(newline="", encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            if row.get("network_type") != "sewer":
                continue
            ulon, ulat = fnum(row["upstream_lon"]), fnum(row["upstream_lat"])
            dlon, dlat = fnum(row["downstream_lon"]), fnum(row["downstream_lat"])
            if None in (ulon, ulat, dlon, dlat):
                skipped += 1
                continue
            segs.append({
                "u": (fnum(row["upstream_x"], 0.0), fnum(row["upstream_y"], 0.0)),
                "d": (fnum(row["downstream_x"], 0.0), fnum(row["downstream_y"], 0.0)),
                "ull": (ulon, ulat),
                "dll": (dlon, dlat),
                "dia": fnum(row["nominal_diameter_m"]),
                "w": fnum(row["nominal_width_m"]),
                "h": fnum(row["nominal_depth_m"]),
                "cover": fnum(row["mcg_depth_below_ground_m"]),
                "inv_u": fnum(row["upstream_invert_m"]),
                "inv_d": fnum(row["downstream_invert_m"]),
                "cap": fnum(row["capacity_full_m3s"]),
                "cap_eff": fnum(row["effective_capacity_90pct_m3s"]),
                "mat": (row.get("mcg_material") or "").strip(),
                "cond": (row.get("mcg_condition") or "").strip(),
                "ward": (row.get("updated_ward") or "").strip(),
                "zone": (row.get("zone") or "").strip(),
                "len": fnum(row["length_m"], 0.0),
                "own": (row.get("maintained_by") or row.get("ownership") or "").strip(),
                "desilt": (row.get("mcg_desilting_type") or "").strip(),
                "desilt_end": (row.get("mcg_desilting_end_date") or "").strip(),
            })
    return segs, skipped


def key(pt):
    return (round(pt[0] / SNAP_M), round(pt[1] / SNAP_M))


def attr_class(s):
    """Segments only weld together when these match — so a chain has one size."""
    return (round(s["dia"] or 0, 3), round(s["w"] or 0, 3), round(s["h"] or 0, 3), s["mat"])


def chain(segs):
    """Weld upstream→downstream stubs into maximal single-attribute polylines."""
    out_edges = defaultdict(list)   # node key → [segment index]
    in_deg = defaultdict(int)
    for i, s in enumerate(segs):
        out_edges[key(s["u"])].append(i)
        in_deg[key(s["d"])] += 1

    used = [False] * len(segs)
    chains = []
    for i, s in enumerate(segs):
        if used[i]:
            continue
        # Only start a chain at a genuine head: nothing feeds this node, or the
        # node branches, or the class changes. Otherwise we'd cut mid-run.
        cur = i
        chain_segs = []
        while True:
            used[cur] = True
            chain_segs.append(cur)
            dk = key(segs[cur]["d"])
            nxt = [j for j in out_edges.get(dk, []) if not used[j]]
            # stop at junctions (fan-out or fan-in) and at attribute changes
            if len(nxt) != 1 or in_deg[dk] > 1 or len(out_edges.get(dk, [])) > 1:
                break
            j = nxt[0]
            if attr_class(segs[j]) != attr_class(segs[cur]):
                break
            cur = j
        chains.append(chain_segs)
    return chains


def perp_dist(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(pts, tol):
    """Iterative Douglas–Peucker (recursion blows the stack on long mains)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi - lo < 2:
            continue
        worst, wi = tol, -1
        for k in range(lo + 1, hi):
            d = perp_dist(pts[k], pts[lo], pts[hi])
            if d > worst:
                worst, wi = d, k
        if wi > 0:
            keep[wi] = True
            stack.append((lo, wi))
            stack.append((wi, hi))
    return [p for p, k in zip(pts, keep) if k]


def main():
    if not SRC.is_file():
        sys.exit(f"source CSV not found: {SRC}")
    print(f"reading {SRC.name} …")
    segs, skipped = load_segments()
    print(f"  {len(segs):,} sewer segments ({skipped:,} skipped: no coordinates)")

    chains = chain(segs)
    print(f"  welded into {len(chains):,} chains")

    features = []
    total_km = 0.0
    for cs in chains:
        first = segs[cs[0]]
        pts = [first["ull"]]
        for i in cs:
            pts.append(segs[i]["dll"])
        pts = simplify(pts, SIMPLIFY_DEG)
        if len(pts) < 2:
            continue
        length = sum(segs[i]["len"] or 0.0 for i in cs)
        total_km += length / 1000.0
        covers = [segs[i]["cover"] for i in cs if segs[i]["cover"] is not None]
        caps = [segs[i]["cap"] for i in cs if segs[i]["cap"] is not None]
        last = segs[cs[-1]]

        props = {
            "n": len(cs),
            "len_m": round(length, 1),
            "dia_m": first["dia"],
            "cover_m": round(sum(covers) / len(covers), 2) if covers else None,
            "inv_u": round(first["inv_u"], 2) if first["inv_u"] is not None else None,
            "inv_d": round(last["inv_d"], 2) if last["inv_d"] is not None else None,
            "cap_m3s": round(max(caps), 4) if caps else None,
            "mat": first["mat"] or None,
            "cond": first["cond"] or None,
            "ward": first["ward"] or None,
            "zone": first["zone"] or None,
            "own": first["own"] or None,
            "desilt": first["desilt"] or None,
        }
        # Drop empty keys — at 30k+ features the nulls alone cost megabytes.
        props = {k: v for k, v in props.items() if v not in (None, "")}
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {
                "type": "LineString",
                "coordinates": [[round(x, 6), round(y, 6)] for x, y in pts],
            },
        })

    fc = {
        "type": "FeatureCollection",
        "properties": {
            "source": "MCG/GMDA sewer utility inventory (d_june_5_actual_storm_plus_sewer_segments.csv)",
            "network": "sewer",
            "segments": len(segs),
            "chains": len(features),
            "length_km": round(total_km, 1),
            "note": "Real recorded assets. Diameters/materials/inverts as provided; "
                    "capacities are Manning full-flow from the recorded geometry.",
        },
        "features": features,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fc, separators=(",", ":")))
    mb = OUT.stat().st_size / 1e6
    print(f"wrote {OUT} — {len(features):,} chains, {total_km:,.1f} km, {mb:.1f} MB")


if __name__ == "__main__":
    main()
