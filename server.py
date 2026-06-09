"""FloodTwin Flask server.

Entry point for local dev (python server.py) and production WSGI
(gunicorn server:app). Serves the SPA and streams the polygon/chunk
binary data with long-lived cache headers.
"""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_from_directory, Response

BASE_DIR = Path(__file__).parent.resolve()

# Load BASE_DIR/.env into os.environ if present. Silent no-op when the
# file or python-dotenv is missing, so prod (where vars come from the
# process manager) and dev (where they come from .env) both work.
try:
    from dotenv import load_dotenv
    load_dotenv(BASE_DIR / ".env")
except ImportError:
    pass

CHUNKS_DIR   = BASE_DIR / "chunks"
DEM_TILES_DIR = BASE_DIR / "static" / "dem_tiles"

DEFAULT_MAPPLS_KEY = "07ed2c801ad7e2fd64b3fdffd084b0be"
ONE_WEEK_SECONDS   = 60 * 60 * 24 * 7
DEBUG_MODE         = os.environ.get("FLASK_DEBUG", "0") == "1"
# Always serve static assets with no caching while we're iterating —
# without this, every JS edit requires a manual hard-reload in the browser.
STATIC_MAX_AGE     = 0

app = Flask(
    __name__,
    static_folder="static",
    template_folder="templates",
)
app.config["JSON_SORT_KEYS"] = False
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = STATIC_MAX_AGE


def _mappls_api_key() -> str:
    return os.environ.get("MAPPLS_API_KEY", DEFAULT_MAPPLS_KEY)


_MAPPLS_TOKEN_URL  = "https://outpost.mappls.com/api/security/oauth/token"
_MAPPLS_NEARBY_URL = "https://atlas.mappls.com/api/places/nearby/json"
# The account's Nearby endpoint accepts plain keywords ("hospital", "school")
# rather than category codes; allow any short alphanumeric phrase.
_MAPPLS_KEYWORD_RE = re.compile(r"^[a-z][a-z _-]{1,31}$")

_token_lock  = threading.Lock()
_token_cache = {"value": None, "expires_at": 0.0}


def _mappls_oauth_token() -> str:
    """Mint or reuse a Mappls OAuth2 client-credentials token.

    Returns "" when credentials are not configured so callers can fall
    back gracefully.
    """
    client_id     = os.environ.get("MAPPLS_CLIENT_ID", "")
    client_secret = os.environ.get("MAPPLS_CLIENT_SECRET", "")
    if not (client_id and client_secret):
        return ""

    with _token_lock:
        now = time.time()
        if _token_cache["value"] and _token_cache["expires_at"] - 60 > now:
            return _token_cache["value"]

        body = urllib.parse.urlencode({
            "grant_type":    "client_credentials",
            "client_id":     client_id,
            "client_secret": client_secret,
        }).encode("utf-8")
        req = urllib.request.Request(
            _MAPPLS_TOKEN_URL,
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent":   "FloodTwin/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))

        token   = payload.get("access_token", "")
        expires = float(payload.get("expires_in", 3600))
        if not token:
            return ""
        _token_cache["value"]      = token
        _token_cache["expires_at"] = now + expires
        return token


def _cache(response, max_age: int = STATIC_MAX_AGE, public: bool = True):
    response.cache_control.max_age = max_age
    response.cache_control.public = public
    return response


# Belt-and-suspenders: force EVERY response to be uncacheable while iterating.
# Without this the browser keeps serving stale JS even with `max-age=0` because
# Chrome's disk cache occasionally returns stale entries. `no-store` is
# absolute: the browser must not write the response to cache at all.
@app.after_request
def _disable_caching(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.route("/")
def index():
    return render_template(
        "index.html",
        mappls_api_key=_mappls_api_key(),
    )


@app.route("/polygon_index.json")
def polygon_index():
    return _cache(send_from_directory(
        str(BASE_DIR),
        "polygon_index.json",
        mimetype="application/json",
    ))


@app.route("/coordinates.bin")
def coordinates():
    return _cache(send_from_directory(
        str(BASE_DIR),
        "coordinates.bin",
        mimetype="application/octet-stream",
    ))


@app.route("/chunks/<path:filename>")
def chunks(filename: str):
    if not filename.endswith(".bin") or "/" in filename or "\\" in filename:
        abort(404)
    return _cache(send_from_directory(
        str(CHUNKS_DIR),
        filename,
        mimetype="application/octet-stream",
    ))


@app.route("/dem_tiles/<int:z>/<int:x>/<int:y>.png")
def dem_tiles(z: int, x: int, y: int):
    if not (9 <= z <= 13):
        abort(404)
    tile_path = DEM_TILES_DIR / str(z) / str(x) / f"{y}.png"
    if not tile_path.exists():
        abort(404)
    return _cache(send_from_directory(
        str(tile_path.parent),
        tile_path.name,
        mimetype="image/png",
    ))


@app.route("/prediction.geojson")
def prediction_geojson():
    return _cache(send_from_directory(
        str(BASE_DIR),
        "prediction.geojson",
        mimetype="application/geo+json",
    ))


@app.route("/assets/<path:filename>")
def city_assets(filename: str):
    # Whitelist the GLBs that back the 3D-city overlay.
    if filename not in {"trees.glb", "cricket_stadium.glb", "football.glb", "grass_green.glb"}:
        abort(404)
    return _cache(send_from_directory(
        str(BASE_DIR),
        filename,
        mimetype="model/gltf-binary",
    ))


@app.route("/api/route")
def route_proxy():
    """Proxy Mappls route_adv to avoid browser CORS restriction."""
    pts = request.args.get("pts", "")
    if not pts:
        return jsonify(error="missing pts"), 400
    # Validate: only allow two semicolon-separated lng,lat pairs
    parts = pts.split(";")
    if len(parts) != 2:
        return jsonify(error="exactly two waypoints required"), 400
    for part in parts:
        coords = part.split(",")
        if len(coords) != 2:
            return jsonify(error="bad coordinate format"), 400
        try:
            float(coords[0]); float(coords[1])
        except ValueError:
            return jsonify(error="non-numeric coordinate"), 400

    key = _mappls_api_key()
    url = (
        f"https://apis.mappls.com/advancedmaps/v1/{key}"
        f"/route_adv/driving/{urllib.parse.quote(pts, safe=',;.')}"
        f"?geometries=geojson&overview=full"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "FloodTwin/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read()
        return Response(body, mimetype="application/json")
    except Exception as exc:
        return jsonify(error=str(exc)), 502



@app.route("/api/assets/nearby")
def assets_nearby():
    """Proxy Mappls Nearby Places API for critical-asset categories.

    Query params:
      cat         — Mappls category code (HSP, SCH, CLG, FIR, POL, PHRM)
      refLocation — "lat,lng" reference point
      radius      — metres (default 10000, capped at 20000)
    """
    cat = (request.args.get("cat") or "").strip().lower()
    if not _MAPPLS_KEYWORD_RE.match(cat):
        return jsonify(error="bad_category"), 400

    ref_location = (request.args.get("refLocation") or "").strip()
    if "," not in ref_location:
        return jsonify(error="bad_refLocation"), 400
    try:
        lat_str, lng_str = ref_location.split(",", 1)
        float(lat_str); float(lng_str)
    except ValueError:
        return jsonify(error="bad_refLocation"), 400

    try:
        radius = int(request.args.get("radius", "10000"))
    except ValueError:
        return jsonify(error="bad_radius"), 400
    radius = max(100, min(radius, 20000))

    token = _mappls_oauth_token()
    if not token:
        return jsonify(error="mappls_oauth_not_configured"), 503

    qs = urllib.parse.urlencode({
        "keywords":    cat,
        "refLocation": ref_location,
        "radius":      radius,
        "page":        1,
    })
    url = f"{_MAPPLS_NEARBY_URL}?{qs}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "User-Agent":    "FloodTwin/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read()
        return Response(body, mimetype="application/json")
    except urllib.error.HTTPError as exc:
        return jsonify(error=f"mappls_http_{exc.code}"), 502
    except Exception as exc:
        return jsonify(error=str(exc)), 502


_OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
# Critical-asset categories → OSM amenity tags. Mirrors CRITICAL_ASSETS in app.js.
_ASSET_AMENITIES = {
    "hospital":     ["hospital"],
    "school":       ["school"],
    "college":      ["college", "university"],
    "fire_station": ["fire_station"],
    "police":       ["police"],
    "pharmacy":     ["pharmacy"],
}
_ASSETS_TTL_SECONDS = 60 * 60 * 6   # OSM amenities barely change; cache 6h
_assets_lock  = threading.Lock()
_assets_cache = {}  # bbox str → {"value": [...], "expires_at": float}


def _fetch_overpass_assets(bbox: str):
    """Fetch all critical-asset amenities within bbox from Overpass.

    Tries each mirror in turn with a short per-request timeout; returns the
    parsed element list from the first that responds. Raises on total failure.
    bbox is "south,west,north,east".
    """
    stmts = "".join(
        f'node["amenity"="{a}"]({bbox});way["amenity"="{a}"]({bbox});'
        for amenities in _ASSET_AMENITIES.values()
        for a in amenities
    )
    query = f"[out:json][timeout:25];({stmts});out center tags;"
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")

    last_err = None
    for mirror in _OVERPASS_MIRRORS:
        try:
            req = urllib.request.Request(
                mirror, data=data,
                headers={"User-Agent": "FloodTwin/1.0",
                         "Content-Type": "application/x-www-form-urlencoded"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            return payload.get("elements", [])
        except Exception as exc:  # noqa: BLE001 — try the next mirror
            last_err = exc
            continue
    raise RuntimeError(f"all Overpass mirrors failed: {last_err}")


@app.route("/api/assets")
def assets():
    """Server-side Overpass proxy for critical assets, grouped by category.

    The browser hitting public Overpass directly is rate-limited per-IP and
    flaky; proxying here lets us retry across several mirrors and cache the
    result so repeat loads are instant and don't re-hammer Overpass.

    Query param:
      bbox — "south,west,north,east" (defaults to the Gurugram extent)
    Response: { "<category>": [ {name, lat, lng, address}, ... ], ... }
    """
    bbox = (request.args.get("bbox") or "28.20,76.70,28.60,77.30").strip()
    # Validate: exactly four comma-separated floats.
    parts = bbox.split(",")
    if len(parts) != 4:
        return jsonify(error="bad_bbox"), 400
    try:
        for p in parts:
            float(p)
    except ValueError:
        return jsonify(error="bad_bbox"), 400

    now = time.time()
    with _assets_lock:
        hit = _assets_cache.get(bbox)
        if hit and hit["expires_at"] > now:
            return jsonify(hit["value"])

    try:
        elements = _fetch_overpass_assets(bbox)
    except Exception as exc:  # noqa: BLE001
        # Serve a stale cache entry if we have one rather than failing hard.
        stale = _assets_cache.get(bbox)
        if stale:
            return jsonify(stale["value"])
        return jsonify(error=str(exc)), 502

    amenity_to_cat = {a: cat for cat, ams in _ASSET_AMENITIES.items() for a in ams}
    buckets = {cat: [] for cat in _ASSET_AMENITIES}
    for el in elements:
        tags = el.get("tags") or {}
        cat = amenity_to_cat.get(tags.get("amenity"))
        if not cat:
            continue
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lng = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lng is None:
            continue
        address = ", ".join(filter(None, [
            tags.get("addr:housenumber"),
            tags.get("addr:street") or tags.get("addr:place"),
            tags.get("addr:city") or tags.get("addr:district"),
        ]))
        buckets[cat].append({
            "name": tags.get("name") or tags.get("name:en") or "Unnamed",
            "lat": lat, "lng": lng, "address": address,
        })

    with _assets_lock:
        _assets_cache[bbox] = {"value": buckets, "expires_at": now + _ASSETS_TTL_SECONDS}
    return jsonify(buckets)


@app.route("/healthz")
def healthz():
    return jsonify(status="ok")


@app.errorhandler(404)
def not_found(_err):
    return jsonify(error="not_found"), 404


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "9121"))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
