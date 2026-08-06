#!/usr/bin/env python3
"""Classify every solved conduit as STORM or SEWER, from the MCG asset inventory.

Why this exists
---------------
The coupled run ships one undifferentiated network: 118,768 nodes / 139,798
links, with no `network_type` on either the binaries or the partner API's
per-frame GeoJSON. But the MCG/GMDA inventory
(`d_june_5_actual_storm_plus_sewer_segments.csv`) has 28,064 storm + 113,757
sewer segments = 141,821 — within 1.4 % of the run's link count, and a spot
check put 91.9 % of sewer chain endpoints within 8 m of a solved node at a
MEDIAN distance of 0.21 m. Those are the same assets.

So the run already solves the sewers; it just doesn't say which are which. This
script recovers that by matching each CSV segment's (upstream, downstream)
endpoint pair to a solved link, and writes one byte per link:

    0 = storm    1 = sewer    2 = unmatched (left unclassified, never guessed)

    python3 build_link_classes.py
      → drainage/sim/drain_link_class.bin   (u8 × n_links)
      → drainage/sim/drain_node_class.bin   (u8 × n_nodes)

Nothing is imputed: a link the inventory does not cover stays class 2 and the
UI renders it as "unclassified conduit" rather than pretending it is one or the
other.
"""
from __future__ import annotations

import collections
import csv
import json
import math
import sys
from pathlib import Path

import numpy as np

BASE = Path(__file__).parent.resolve()
SIM = BASE / "drainage" / "sim"
CSV_PATH = BASE / "drainage" / "d_june_5_actual_storm_plus_sewer_segments.csv"

STORM, SEWER, UNKNOWN = 0, 1, 2
SNAP_M = 8.0            # endpoint match tolerance
CELL_DEG = 2.0e-5       # ~2.2 m spatial-hash cell

csv.field_size_limit(1 << 24)


def load_run():
    man = json.loads((SIM / "manifest.json").read_text())
    nn, nl = man["n_nodes"], man["n_links"]
    raw = (SIM / "drain_geom.bin").read_bytes()
    lonlat = np.frombuffer(raw, dtype="<f4", count=nn * 2).reshape(nn, 2)
    links = np.frombuffer(raw, dtype="<u4", offset=nn * 8, count=nl * 2).reshape(nl, 2)
    return man, lonlat, links


def build_index(lonlat):
    grid = collections.defaultdict(list)
    for i, (lo, la) in enumerate(lonlat):
        grid[(int(lo / CELL_DEG), int(la / CELL_DEG))].append(i)
    return grid


def nearest(grid, lonlat, lo, la, tol_deg):
    kx, ky = int(lo / CELL_DEG), int(la / CELL_DEG)
    best, bd = -1, tol_deg * tol_deg
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for i in grid.get((kx + dx, ky + dy), ()):
                d = (lonlat[i, 0] - lo) ** 2 + (lonlat[i, 1] - la) ** 2
                if d < bd:
                    bd, best = d, i
    return best


def main():
    if not CSV_PATH.is_file():
        sys.exit(f"inventory not found: {CSV_PATH}")
    man, lonlat, links = load_run()
    nn, nl = man["n_nodes"], man["n_links"]
    print(f"run: {nn:,} nodes / {nl:,} links")

    grid = build_index(lonlat)
    # link lookup keyed on the unordered node pair — the inventory's flow
    # direction and the solver's may disagree, and that is irrelevant here.
    pair_to_link = {}
    for k in range(nl):
        a, b = int(links[k, 0]), int(links[k, 1])
        pair_to_link[(a, b) if a < b else (b, a)] = k

    tol_deg = SNAP_M / 111000.0
    link_class = np.full(nl, UNKNOWN, dtype=np.uint8)
    node_class = np.full(nn, UNKNOWN, dtype=np.uint8)

    stats = collections.Counter()
    with CSV_PATH.open(newline="", encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            kind = STORM if row["network_type"] == "storm" else SEWER
            stats["csv_" + row["network_type"]] += 1
            try:
                ulon, ulat = float(row["upstream_lon"]), float(row["upstream_lat"])
                dlon, dlat = float(row["downstream_lon"]), float(row["downstream_lat"])
            except (TypeError, ValueError):
                stats["no_coords"] += 1
                continue
            a = nearest(grid, lonlat, ulon, ulat, tol_deg)
            b = nearest(grid, lonlat, dlon, dlat, tol_deg)
            if a < 0 or b < 0:
                stats["endpoint_unmatched"] += 1
                continue
            # Endpoints identify the node pair even when no link is found, so
            # tag the nodes regardless — manholes need a class too.
            for n in (a, b):
                if node_class[n] == UNKNOWN:
                    node_class[n] = kind
            k = pair_to_link.get((a, b) if a < b else (b, a))
            if k is None:
                stats["no_link_between_endpoints"] += 1
                continue
            link_class[k] = kind
            stats["matched_" + row["network_type"]] += 1

    (SIM / "drain_link_class.bin").write_bytes(link_class.tobytes())
    (SIM / "drain_node_class.bin").write_bytes(node_class.tobytes())

    ln = collections.Counter(link_class.tolist())
    nd = collections.Counter(node_class.tolist())
    name = {STORM: "storm", SEWER: "sewer", UNKNOWN: "unclassified"}
    print("\ninventory rows :", {k: v for k, v in stats.items() if k.startswith("csv_")})
    print("match failures :", {k: v for k, v in stats.items()
                               if k in ("no_coords", "endpoint_unmatched", "no_link_between_endpoints")})
    print("\nLINKS :", {name[k]: f"{v:,} ({100*v/nl:.1f}%)" for k, v in sorted(ln.items())})
    print("NODES :", {name[k]: f"{v:,} ({100*v/nn:.1f}%)" for k, v in sorted(nd.items())})
    print(f"\nwrote {SIM/'drain_link_class.bin'} and {SIM/'drain_node_class.bin'}")


if __name__ == "__main__":
    main()
