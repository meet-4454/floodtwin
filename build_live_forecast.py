#!/usr/bin/env python
"""Partner daily forecast → the `/live` binaries the console actually plays.

The partner publishes each 10-minute frame as a ~66 MB GeoJSON FeatureCollection
in UTM 43N (EPSG:32643), holding three feature families in one file:

    drainage_node  118 733 Points      node_id, drainage_depth_m, surcharged
    drainage_link  102 560 LineStrings link_id, flow_m3ps
    surface_cell        30 Polygons    depth (m)     ← only the WET cells

145 of those is ~9.6 GB of JSON. The console cannot page that, so this script
transcodes each frame to the same compact layout `/sim` uses — u16 mm depth,
int16 flow×100, a surcharge bitmask and a 768² depth grid — which is ~250 MB for
the whole run and lets the app stream one frame at a time.

WHY THE IDS NEED NO MAPPING TABLE
    The partner's `node_id` (0…118 767) and `link_id` (0…139 797) are already
    indices into the SAME network `/sim` solved — verified: every link's
    from/to matches drain_geom.bin exactly, and node coordinates agree to
    0.4 m (that residual is drain_geom.bin's float32 storage, not a disagreement).
    So `/live` ships dynamics only and reuses `/sim`'s geometry — which is what
    lets the dataset switch in the UI cost one manifest and one grid frame.
    A frame omits dry nodes and links; anything absent is written as zero.

EXACTNESS
    The three binaries are reproduced byte-for-byte against the previously built
    run, which pinned down conventions that are easy to get subtly wrong:
      * node depth and link flow TRUNCATE in float64 — `int(v*1000)`, not round.
      * surface depth truncates in float32 — `int(f32(v)*f32(1000))`. Rounding
        instead, or truncating in float64, is off by 1 mm on ~2 % of cells.
      * the surcharge mask packs LITTLE-endian bit order (bit 0 = node 0).
      * a surface cell paints the grid cells its bbox touches, taking the MAX
        where cells overlap — not last-write, which loses the deepest polygon
        wherever two overlap.
      * that bbox is projected by transforming the two UTM corners, NOT all four
        vertices. UTM 43N is ~0.95° off north here, so a vertex-wise min/max
        yields a slightly fatter box and shifts ~0.4 % of cells.
    Residual vs the reference build: 47 cells of 589 824 (0.008 %), all at
    exactly the 50 mm wet threshold, from 12 oversized merged polygons where a
    bbox fill overshoots. Invisible at any depth ramp; documented rather than
    chased, because a true point-in-polygon rasteriser matches far worse (the
    partner's own build is a bbox fill).

Usage
    python build_live_forecast.py               # rebuild only if the run changed
    python build_live_forecast.py --force       # rebuild even if unchanged
    python build_live_forecast.py --check       # print status, build nothing
    python build_live_forecast.py --limit 6     # first 6 frames, for a smoke test

Exit codes: 0 = up to date or rebuilt, 1 = failed, 2 = partner unreachable.
"""
from __future__ import annotations

import argparse
import gzip as _gzip
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from pyproj import Transformer

BASE_DIR = Path(__file__).parent.resolve()
SIM_DIR = BASE_DIR / "drainage" / "sim"
LIVE_DIR = BASE_DIR / "drainage" / "live"
STAGE_DIR = BASE_DIR / "drainage" / "live_stage"

IST = timezone(timedelta(hours=5, minutes=30))
DEFAULT_BASE_URL = "https://mcgapi.floodresq.com"
LATEST_PATH = "/api/partners/floodtwin/latest"

# Frame files are named with Python's `{i:02d}` — a MINIMUM width, not a fixed
# one. Frame 7 is "07" and frame 144 is "144"; the front-end pads identically.
# Zero-padding the 145-frame run to three digits would ask for
# surface_grid_000.bin, which does not exist, and 404 every frame under 100.
pad = "{:02d}".format


def log(msg: str) -> None:
    print(msg, flush=True)


# ── partner API ─────────────────────────────────────────────────────────────
def _load_env() -> None:
    """Read BASE_DIR/.env the same way floodtwin/config.py does.

    This script runs from cron, which inherits none of the shell's environment,
    so the key has to come from the file rather than from os.environ alone.
    """
    env_path = BASE_DIR / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def _get(url: str, api_key: str, timeout: int = 180, retries: int = 3) -> bytes:
    """GET with gzip and a bounded retry.

    Over 145 frames a single transient 502 or reset would otherwise abandon a
    20-minute rebuild, so each frame gets three tries with a widening backoff.
    """
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "X-API-Key": api_key,
                "User-Agent": "FloodTwin/2.0",
                "Accept-Encoding": "gzip",
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = _gzip.decompress(raw)
                return raw
        except Exception as exc:  # noqa: BLE001 — retry anything transient
            last = exc
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
    raise last  # type: ignore[misc]


# ── transcode ───────────────────────────────────────────────────────────────
def _transformer(crs_name: str) -> Transformer:
    """Frame CRS → WGS84. Read from the file rather than assumed, but the
    partner has only ever published EPSG:32643 and that is the fallback."""
    epsg = "32643"
    if crs_name and "EPSG::" in crs_name:
        epsg = crs_name.rsplit("::", 1)[-1].strip()
    return Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)


def transcode(raw: bytes, net: dict) -> tuple[bytes, bytes, dict]:
    """One partner frame → (drain_dyn bytes, surface_grid bytes, stats)."""
    doc = json.loads(raw)
    feats = doc.get("features", [])
    tr = _transformer((doc.get("crs") or {}).get("properties", {}).get("name", ""))

    nn, nl = net["n_nodes"], net["n_links"]
    N, bb = net["grid_n"], net["grid_bbox"]

    node_id, node_dep, node_sur = [], [], []
    link_id, link_flow = [], []
    poly_ring, poly_dep = [], []
    for f in feats:
        p = f["properties"]
        kind = p.get("feature_type")
        if kind == "drainage_node":
            node_id.append(p["node_id"])
            node_dep.append(p["drainage_depth_m"])
            node_sur.append(bool(p["surcharged"]))
        elif kind == "drainage_link":
            link_id.append(p["link_id"])
            link_flow.append(p["flow_m3ps"])
        elif kind == "surface_cell":
            poly_ring.append(f["geometry"]["coordinates"][0])
            poly_dep.append(p["depth"])

    # ── drainage dynamics ───────────────────────────────────────────────────
    depth = np.zeros(nn, dtype=np.float64)
    sur = np.zeros(nn, dtype=bool)
    flow = np.zeros(nl, dtype=np.float64)
    if node_id:
        ni = np.asarray(node_id)
        depth[ni] = node_dep
        sur[ni] = node_sur
    if link_id:
        flow[np.asarray(link_id)] = link_flow

    # Truncation, not rounding — matches the reference build exactly.
    depth_u16 = np.clip(depth * net["depth_scale"], 0, 65535).astype(np.int64).astype("<u2")
    flow_i16 = np.clip(flow * net["flow_scale"], -32768, 32767).astype(np.int64).astype("<i2")
    mask = np.packbits(sur, bitorder="little")
    dyn = depth_u16.tobytes() + mask.tobytes() + flow_i16.tobytes()

    # ── surface depth grid ──────────────────────────────────────────────────
    grid = np.zeros((N, N), dtype=np.uint16)
    if poly_ring:
        rings = np.array([np.asarray(r)[:, :2] for r in poly_ring], dtype=np.float64)
        # float32 truncation — see the module docstring.
        mm = (np.asarray(poly_dep, dtype=np.float32) * np.float32(net["depth_scale"])
              ).astype(np.int64).astype(np.uint16)
        lo0, la0 = tr.transform(rings[:, :, 0].min(1), rings[:, :, 1].min(1))
        lo1, la1 = tr.transform(rings[:, :, 0].max(1), rings[:, :, 1].max(1))
        sx = (N - 1) / (bb[2] - bb[0])
        sy = (N - 1) / (bb[3] - bb[1])
        x0 = np.clip(((np.asarray(lo0) - bb[0]) * sx).astype(int), 0, N)
        x1 = np.clip(((np.asarray(lo1) - bb[0]) * sx).astype(int) + 2, 0, N)
        y0 = np.clip(((np.asarray(la0) - bb[1]) * sy).astype(int), 0, N)
        y1 = np.clip(((np.asarray(la1) - bb[1]) * sy).astype(int) + 2, 0, N)
        for i in range(len(mm)):
            blk = grid[y0[i]:y1[i], x0[i]:x1[i]]
            np.maximum(blk, mm[i], out=blk)

    stats = {
        "nodes": len(node_id),
        "links": len(link_id),
        "surcharged": int(sur.sum()),
        "wet_cells": int(np.count_nonzero(grid)),
        # float32 so the value reads identically to the reference manifests.
        "max_depth_m": float(np.float32(max(poly_dep))) if poly_dep else 0.0,
    }
    return dyn, grid.tobytes(), stats


# ── build ───────────────────────────────────────────────────────────────────
def build(latest: dict, net: dict, base_url: str, api_key: str,
          workers: int, limit: int | None) -> None:
    frames = latest["frames"]
    # A --limit run is a smoke test: it builds into the stage and throws the
    # stage away. It must never swap, because a 6-frame /live would leave the
    # console with a manifest promising 6 frames of a 145-frame day, and a
    # leftover stage directory makes /api/live-forecast/status report "building"
    # forever.
    swap = not limit
    if limit:
        frames = frames[:limit]
    run_id = latest["run_id"]

    if STAGE_DIR.exists():
        shutil.rmtree(STAGE_DIR)
    STAGE_DIR.mkdir(parents=True)

    stats: dict[int, dict] = {}
    t0 = time.time()
    done = 0

    def write(name: str, payload: bytes) -> None:
        """Write a frame binary and its gzip sidecar.

        The sidecar is what the app is actually served (floodtwin/http.py picks
        it up). Compressing here — once, offline, while we already hold the
        bytes — replaces compressing on demand in every gunicorn worker on the
        first request for every frame, which was a visible stutter the first
        time anyone played the timeline through. Level 9 because this runs once
        a day and the bytes then ship thousands of times.
        """
        (STAGE_DIR / name).write_bytes(payload)
        (STAGE_DIR / f"{name}.gz").write_bytes(_gzip.compress(payload, compresslevel=9))

    def one(fr: dict) -> tuple[int, dict]:
        url = base_url + fr["floodtwin_geojson_url"]
        dyn, grid, st = transcode(_get(url, api_key), net)
        i = fr["index"]
        write(f"drain_dyn_{pad(i)}.bin", dyn)
        write(f"surface_grid_{pad(i)}.bin", grid)
        return i, st

    # Frames are independent, and each is network-bound for most of its life, so
    # the pool is sized for the partner's throughput rather than for CPU.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, st in pool.map(one, frames):
            stats[i] = st
            done += 1
            if done % 20 == 0 or done == len(frames):
                log(f"  {done}/{len(frames)} frames  ({time.time() - t0:.0f}s)")

    manifest = {
        "source": f"MCG partner daily forecast ({run_id})",
        "dataset": "live_forecast",
        "run_id": run_id,
        "base_valid_time": frames[0]["valid_at"],
        "time_step_min": latest["time_step_min"],
        "generated_at": datetime.now(IST).strftime("%Y-%m-%dT%H:%M:%S%z"),
        "n_hours": len(frames),
        "n_nodes": net["n_nodes"],
        "n_links": net["n_links"],
        "depth_scale": net["depth_scale"],
        "flow_scale": net["flow_scale"],
        "wet_threshold_m": net["wet_threshold_m"],
        "grid_n": net["grid_n"],
        "grid_bbox": net["grid_bbox"],
        "outfall_nodes": net["outfall_nodes"],
        "bbox": net["bbox"],
        "static_from": "/sim",
        "frames": [{
            "index": fr["index"],
            "minute": fr["minute"],
            "valid_time": fr["valid_time"],
            "valid_at": fr["valid_at"],
            "intensity_mmhr": fr.get("intensity_mmhr"),
            **stats[fr["index"]],
        } for fr in frames],
    }
    # Written LAST: a stage directory without a manifest is self-evidently
    # incomplete, which is what makes an interrupted run safe to discard.
    (STAGE_DIR / "manifest.json").write_text(json.dumps(manifest, indent=1))

    mb = sum(f.stat().st_size for f in STAGE_DIR.iterdir()) / 1e6
    if not swap:
        shutil.rmtree(STAGE_DIR)
        log(f"smoke test: {len(frames)} frames → {mb:.0f} MB in "
            f"{time.time() - t0:.0f}s (stage discarded, /live untouched)")
        return

    # Swap the finished dataset in. /live is only absent for the microsecond
    # between the two renames, and never exists half-written — the app keeps
    # playing the previous run right up to the swap.
    prev = BASE_DIR / "drainage" / "live_prev"
    if prev.exists():
        shutil.rmtree(prev)
    if LIVE_DIR.exists():
        os.rename(LIVE_DIR, prev)
    os.rename(STAGE_DIR, LIVE_DIR)
    if prev.exists():
        shutil.rmtree(prev)

    log(f"built {len(frames)} frames → {mb:.0f} MB in {time.time() - t0:.0f}s")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="rebuild even if the run is unchanged")
    ap.add_argument("--check", action="store_true", help="report status only, build nothing")
    ap.add_argument("--limit", type=int, default=None, help="only the first N frames (smoke test)")
    ap.add_argument("--workers", type=int, default=8, help="parallel frame downloads")
    args = ap.parse_args()

    _load_env()
    base_url = os.environ.get("FLOODTWIN_PARTNER_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    api_key = os.environ.get("FLOODTWIN_PARTNER_API_KEY", "")
    if not api_key:
        log("FLOODTWIN_PARTNER_API_KEY is not set — cannot reach the partner")
        return 2

    sim = json.loads((SIM_DIR / "manifest.json").read_text())
    net = {k: sim[k] for k in (
        "n_nodes", "n_links", "depth_scale", "flow_scale",
        "wet_threshold_m", "grid_n", "grid_bbox", "outfall_nodes", "bbox")}
    log(f"target network: {net['n_nodes']} nodes / {net['n_links']} links, "
        f"grid {net['grid_n']}² over {net['grid_bbox']}")

    try:
        latest = json.loads(_get(base_url + LATEST_PATH, api_key, timeout=30))
    except Exception as exc:  # noqa: BLE001
        log(f"partner unreachable: {exc}")
        return 2

    run_id, n = latest["run_id"], len(latest["frames"])
    log(f"run {run_id}: {n} frames @ {latest['time_step_min']} min")

    current = None
    man_p = LIVE_DIR / "manifest.json"
    if man_p.is_file():
        try:
            current = json.loads(man_p.read_text()).get("run_id")
        except (json.JSONDecodeError, OSError):
            current = None

    if args.check:
        log(f"built={current} upstream={run_id} "
            f"{'up to date' if current == run_id else 'STALE — rebuild needed'}")
        return 0

    if current == run_id and not args.force:
        log(f"already up to date ({run_id}, {n} frames) — nothing to do")
        return 0

    if latest.get("status") not in (None, "completed"):
        log(f"run {run_id} is {latest['status']}, not completed — waiting for the next poll")
        return 0

    log(f"rebuilding: {current or 'nothing'} → {run_id}")
    try:
        build(latest, net, base_url, api_key, args.workers, args.limit)
    except Exception as exc:  # noqa: BLE001
        log(f"build failed: {type(exc).__name__}: {exc}")
        if STAGE_DIR.exists():
            shutil.rmtree(STAGE_DIR, ignore_errors=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
