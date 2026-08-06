"""Simulation binaries, drainage GeoJSON and the other static datasets."""
from __future__ import annotations

import re

from flask import Blueprint, abort, jsonify, send_from_directory

from ..config import BASE_DIR, CHUNKS_DIR, DEM_TILES_DIR, DRAINAGE_DIR, LIVE_DIR, SIM_DIR
from ..http import cache, send_data

bp = Blueprint("data", __name__)


# Real-data layers only. The synthetic SWMM / catchment / recharge /
# pump-discharge / inlet-link / MCG-proxy chain layers were deleted outright;
# `sewer_network` is the MCG/GMDA sewer inventory built by build_sewer_network.py.
_DRAINAGE_LAYERS = {
    "drain_network", "trunk_legs", "drain_work_status",
    "outfalls", "discharge_points",
    "manholes_progression", "backflow_nodes", "pumps", "inlets_rim",
    "sewer_network",
}


@bp.route("/drainage/<layer>.geojson")
def drainage_layer(layer: str):
    if layer not in _DRAINAGE_LAYERS:
        abort(404)
    return send_data(DRAINAGE_DIR, f"{layer}.geojson", "application/geo+json")


@bp.route("/drainage/hydrograph.json")
def drainage_hydrograph():
    return send_data(DRAINAGE_DIR, "hydrograph.json", "application/json")


@bp.route("/wards_gurugram.geojson")
def wards_gurugram():
    return send_data(BASE_DIR, "wards_gurugram.geojson", "application/geo+json")


# ── Coupled 1D-2D simulation binaries (build_sim_binaries.py) ────────────────
# Geometry once + one quantised chunk per frame. Frame indices are 2-digit for
# the 13-hour July event and 3-digit for the 145-frame daily forecast.
_SIM_RE = re.compile(
    r"^(drain_geom|drain_node_static|drain_link_static"
    r"|drain_link_class|drain_node_class|surface_geom"
    r"|drain_dyn_\d{2,3}|surface_\d{2,3}|surface_grid_\d{2,3})\.bin$"
)


@bp.route("/sim/manifest.json")
def sim_manifest():
    return send_data(SIM_DIR, "manifest.json", "application/json")


@bp.route("/sim/<path:filename>")
def sim_binary(filename: str):
    if not _SIM_RE.match(filename):
        abort(404)
    return send_data(SIM_DIR, filename, "application/octet-stream")


# ── Live forecast dynamics (build_live_forecast.py) ──────────────────────────
# Same binary contract, rebuilt daily. Only the DYNAMICS live here — the network
# geometry is shared and immutable, so the frontend keeps loading
# drain_geom/node_static/link_static from /sim.
@bp.route("/live/manifest.json")
def live_manifest():
    if not (LIVE_DIR / "manifest.json").is_file():
        return jsonify(error="live_forecast_not_built"), 404
    return send_data(LIVE_DIR, "manifest.json", "application/json")


@bp.route("/live/<path:filename>")
def live_binary(filename: str):
    if not _SIM_RE.match(filename):
        abort(404)
    return send_data(LIVE_DIR, filename, "application/octet-stream")


# ── Legacy scenario polygons ─────────────────────────────────────────────────
# Superseded by the coupled run: the frontend no longer fetches these, and the
# ~44 MB they cost is the bulk of the old cold load. Kept reachable so archived
# builds and offline analysis still resolve.
@bp.route("/polygon_index.json")
def polygon_index():
    return cache(send_from_directory(str(BASE_DIR), "polygon_index.json", mimetype="application/json"))


@bp.route("/coordinates.bin")
def coordinates():
    return send_data(BASE_DIR, "coordinates.bin", "application/octet-stream")


@bp.route("/chunks/<path:filename>")
def chunks(filename: str):
    if not filename.endswith(".bin") or "/" in filename or "\\" in filename:
        abort(404)
    return send_data(CHUNKS_DIR, filename, "application/octet-stream")


@bp.route("/dem_tiles/<int:z>/<int:x>/<int:y>.png")
def dem_tiles(z: int, x: int, y: int):
    if not (9 <= z <= 13):
        abort(404)
    tile = DEM_TILES_DIR / str(z) / str(x) / f"{y}.png"
    if not tile.exists():
        abort(404)
    return cache(send_from_directory(str(tile.parent), tile.name, mimetype="image/png"))
