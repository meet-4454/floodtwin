"""Geocoding, reverse-geocoding and routing proxies.

All of these exist so an API key never reaches the browser, and so responses can
be cached process-wide instead of per tab. The locality batch in particular:
browsers reverse-geocoding hotspots directly get throttled per-tab by Nominatim
and resolve serially, whereas here a whole panel fills in one round trip.
"""
from __future__ import annotations

import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import Blueprint, Response, jsonify, request

from ..config import GURUGRAM_CENTER, google_places_api_key, mappls_api_key

bp = Blueprint("geo", __name__)

_AUTOCOMPLETE = "https://places.googleapis.com/v1/places:autocomplete"
_PLACE_DETAILS = "https://places.googleapis.com/v1/places/"
_NEARBY = "https://places.googleapis.com/v1/places:searchNearby"
# Reverse-geocoding used to go to nominatim.openstreetmap.org. It is gone on
# purpose: the public instance allows ~1 req/s and answered this server with 429
# on every call, so the hotspot panel never resolved a single name. See
# _google_locality below.


@bp.route("/api/config")
def client_config():
    """The only configuration the browser is allowed to see."""
    return jsonify(mapplsApiKey=mappls_api_key())


@bp.route("/api/geocode/autocomplete")
def geocode_autocomplete():
    """Typeahead for the search bar, biased to Gurugram so local results rank first."""
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify(suggestions=[])
    key = google_places_api_key()
    if not key:
        return jsonify(error="google_places_not_configured"), 503

    body = json.dumps({
        "input": q,
        "locationBias": {"circle": {
            "center": {"latitude": GURUGRAM_CENTER[0], "longitude": GURUGRAM_CENTER[1]},
            "radius": 30000,
        }},
    }).encode("utf-8")
    req = urllib.request.Request(_AUTOCOMPLETE, data=body, headers={
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "User-Agent": "FloodTwin/2.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return jsonify(error=f"google_http_{exc.code}"), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=str(exc)), 502

    out = []
    for s in data.get("suggestions", []):
        pp = s.get("placePrediction") or {}
        if not pp.get("placeId"):
            continue
        sf = pp.get("structuredFormat") or {}
        out.append({
            "placeId": pp["placeId"],
            "main": (sf.get("mainText") or {}).get("text") or (pp.get("text") or {}).get("text", ""),
            "secondary": (sf.get("secondaryText") or {}).get("text", ""),
            "description": (pp.get("text") or {}).get("text", ""),
        })
    return jsonify(suggestions=out)


@bp.route("/api/geocode/place")
def geocode_place():
    """Resolve an autocomplete placeId to coordinates + address."""
    pid = (request.args.get("id") or "").strip()
    if not pid or not re.match(r"^[A-Za-z0-9_\-]+$", pid):
        return jsonify(error="bad_place_id"), 400
    key = google_places_api_key()
    if not key:
        return jsonify(error="google_places_not_configured"), 503

    req = urllib.request.Request(_PLACE_DETAILS + urllib.parse.quote(pid), headers={
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "id,displayName,location,formattedAddress",
        "User-Agent": "FloodTwin/2.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return jsonify(error=f"google_http_{exc.code}"), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=str(exc)), 502

    loc = data.get("location") or {}
    return jsonify(
        lat=loc.get("latitude"), lng=loc.get("longitude"),
        name=(data.get("displayName") or {}).get("text") or "",
        address=data.get("formattedAddress") or "",
    )


_locality_lock = threading.Lock()
_locality_cache: dict[str, str] = {}
_LOCALITY_CACHE_LIMIT = 4096
_locality_loaded = None         # mtime of the cache file this worker last merged
_locality_dirty = 0
# Marks a cell the geocoder genuinely cannot name (open ground, outside every
# ward). Stored like any other answer so it is never asked for twice, and
# translated back to "" on the way out. Without it, exactly the cells that cost
# a full Google round trip AND return nothing were the ones re-queried on every
# single request — the server-side twin of the "Locating…" loop.
_UNNAMED = "\x00"


def _cell(lat, lng):
    return f"{lat:.3f},{lng:.3f}"


def _cache_path():
    from ..config import BASE_DIR
    return BASE_DIR / "drainage" / "locality_cache.json"


def _cache_load():
    """Warm the in-memory cache from disk, once per worker.

    THE POINT: gunicorn runs four workers, each with its own memory, so a name
    resolved by one was re-fetched by the other three — and every restart threw
    the lot away and paid for it again. Gurugram floods in the same places, so
    after a day or two of use this file covers essentially every hotspot cell
    the panel ever asks for, and the whole endpoint answers from memory with no
    Google call at all. That is the difference between "fast because Google was
    fast just then" and "fast".
    """
    global _locality_loaded
    p = _cache_path()
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return                      # no cache file yet; nothing to merge
    # Re-read whenever ANOTHER worker has written since we last looked. Loading
    # only once meant a worker that started before the file existed never saw a
    # single entry the other three resolved, so three of four requests stayed
    # slow forever — the sharing this file exists for never actually happened.
    if _locality_loaded == mtime:
        return
    _locality_loaded = mtime
    try:
        data = json.loads(p.read_text())
        if isinstance(data, dict):
            for k, v in data.items():
                # setdefault: our own in-memory entries are at least as fresh.
                if isinstance(k, str) and isinstance(v, str) and v:
                    _locality_cache.setdefault(k, v)
    except (OSError, json.JSONDecodeError, ValueError):
        pass                        # a corrupt cache is rebuilt, not fatal


def _cache_get(key):
    with _locality_lock:
        _cache_load()
        return _locality_cache.get(key)


def _cache_put(key, name):
    global _locality_dirty
    with _locality_lock:
        _cache_load()
        if _locality_cache.get(key) == name:
            return
        _locality_cache[key] = name
        if len(_locality_cache) > _LOCALITY_CACHE_LIMIT:
            del _locality_cache[next(iter(_locality_cache))]
        _locality_dirty += 1


def _cache_flush():
    """Persist newly-resolved names. Called once at the end of a request.

    Flushing on a counter alone left a TAIL: the last few names of a batch sat
    in one worker's memory until enough more accumulated to trip the threshold,
    so the other three workers kept paying a full Google round trip for exactly
    those cells. Writing once per request — not once per name — keeps the file
    off the hot path while guaranteeing nothing resolved is left unshared.
    """
    global _locality_dirty
    with _locality_lock:
        if not _locality_dirty:
            return
        _locality_dirty = 0
        snapshot = {k: v for k, v in _locality_cache.items()}
    try:
        p = _cache_path()
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(snapshot))
        # Atomic: four workers write this file, and a torn one would be read
        # back as corrupt on the next boot.
        tmp.replace(p)
    except OSError:
        pass                        # a cache we cannot persist is still a cache


# ── ward polygons: the offline fallback ─────────────────────────────────────
# The 36 MCG ward polygons, already in the tree for the map's ward layer. Loaded
# once, lazily, and used as the answer of last resort so a hotspot ALWAYS has a
# name even with every network geocoder down. "Ward No.5" is not the name an
# operator would say out loud, but it locates the pocket, and it can never fail.
#
# The wards are MultiPolygons in CRS84 ([lng,lat]) — which the ring test below
# takes as given. The file this replaced stored its rings [lat,lng], so the
# bounding boxes were built from swapped ordinates and NOTHING ever fell inside
# one: the fallback silently returned "" for every point in the city.
_wards_lock = threading.Lock()
_wards: list[tuple[str, float, float, float, float, list]] | None = None


def _load_wards():
    global _wards
    with _wards_lock:
        if _wards is not None:
            return _wards
        out = []
        try:
            from ..config import BASE_DIR
            doc = json.loads((BASE_DIR / "Gurugram_wards.geojson").read_text())
            for f in doc.get("features", []):
                g = f.get("geometry") or {}
                t = g.get("type")
                if t == "Polygon":
                    polys = [g["coordinates"]]
                elif t == "MultiPolygon":
                    polys = g["coordinates"]
                else:
                    continue
                props = f.get("properties") or {}
                # "08" → "Ward No.8" — the form an operator reads off the map.
                no = str(props.get("MC_Ward_No") or "").strip().lstrip("0")
                label = f"Ward No.{no}" if no else ""
                town = str(props.get("MC_Name") or "").strip()
                name = ", ".join([p for p in (label, town) if p])
                # Outer rings only; a ward's holes are none of this test's business.
                for poly in polys:
                    ring = [(float(p[0]), float(p[1])) for p in poly[0]]
                    xs = [p[0] for p in ring]
                    ys = [p[1] for p in ring]
                    out.append((name, min(xs), min(ys), max(xs), max(ys), ring))
        except Exception:  # noqa: BLE001 — no wards is survivable, a 500 is not
            out = []
        _wards = out
        return _wards


def _point_in_ring(lng, lat, ring) -> bool:
    """Ray casting. Small enough (36 wards) that an index would be noise."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            if lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-18) + xi:
                inside = not inside
        j = i
    return inside


def _ward_name(lat, lng) -> str:
    for name, x0, y0, x1, y1, ring in _load_wards():
        if x0 <= lng <= x1 and y0 <= lat <= y1 and _point_in_ring(lng, lat, ring):
            return name
    return ""


def _google_locality(lat, lng) -> str:
    """Reverse-geocode via Google.

    NOTE ON WHICH GOOGLE API. The natural endpoint is the Geocoding API
    (maps/api/geocode/json?latlng=…), but it is **not enabled on this project** —
    it answers REQUEST_DENIED, "This API is not activated". Places API (New) IS
    enabled (the search bar's autocomplete uses it), and `places:searchNearby`
    returns the address components of the nearest place, which at a 110 m cell is
    the same answer for our purposes. Enabling the Geocoding API would be
    slightly better and cheaper — one switch in the Cloud Console — and this
    function is the only place that would need to change.

    Replaces Nominatim, which returned **429 to every request**: the public OSM
    instance permits ~1 req/s and this fired several in parallel from a server
    IP, so every lookup failed and the panel sat on "Locating…" forever.

    The field mask asks ONLY for addressComponents. Google bills Places by the
    fields returned, and a mask that pulls displayName/formattedAddress/geometry
    costs more and ships more bytes for data thrown away one line later.
    """
    body = json.dumps({
        "locationRestriction": {"circle": {
            "center": {"latitude": lat, "longitude": lng},
            "radius": 150.0,
        }},
        "maxResultCount": 1,
    }).encode("utf-8")
    req = urllib.request.Request(_NEARBY, data=body, headers={
        "Content-Type": "application/json",
        "X-Goog-Api-Key": google_places_api_key(),
        "X-Goog-FieldMask": "places.addressComponents",
        "User-Agent": "FloodTwin/2.0",
    })
    with urllib.request.urlopen(req, timeout=6) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    comp: dict[str, str] = {}
    for c in ((data.get("places") or [{}])[0]).get("addressComponents", []):
        for ty in c.get("types", []):
            comp.setdefault(ty, c.get("longText") or "")
    # Most specific first, then the containing area — two parts, so a row reads
    # as "where in Gurugram" rather than a full postal address.
    fine = (comp.get("sublocality_level_1") or comp.get("neighborhood")
            or comp.get("sublocality_level_2") or comp.get("route"))
    coarse = (comp.get("locality") or comp.get("administrative_area_level_3")
              or comp.get("administrative_area_level_2"))
    if fine and coarse and fine != coarse:
        return f"{fine}, {coarse}"
    return (fine or coarse or "").strip()


def _reverse_locality(lat, lng):
    """A name for this cell. Google first, ward polygon as the guaranteed floor.

    NOTHING IS CACHED AS A FAILURE. The old version stored "" when the lookup
    failed, and the client reads an empty name as "not resolved yet" — so one
    bad minute pinned a hotspot on "Locating…" for the life of the process while
    it kept asking. The ward fallback means the miss path still produces a real
    string, so the cache only ever holds answers.
    """
    key = _cell(lat, lng)
    hit = _cache_get(key)
    if hit is not None:
        return "" if hit == _UNNAMED else hit

    name = ""
    failed = False
    try:
        name = _google_locality(lat, lng)
    except Exception:  # noqa: BLE001 — fall through to the offline answer
        failed = True
    if not name:
        name = _ward_name(lat, lng)

    # A transport failure is not an answer — leave it uncached so the next poll
    # retries. A successful lookup that simply has no name for this cell IS an
    # answer, and gets remembered as one.
    if name:
        _cache_put(key, name)
    elif not failed:
        _cache_put(key, _UNNAMED)
    return name


@bp.route("/api/locality")
def locality():
    """Batch reverse-geocode "lat,lng;lat,lng;…" → [{lat,lng,name}], cached + parallel."""
    coords = []
    for pair in (request.args.get("pts") or "").split(";"):
        if not pair:
            continue
        try:
            la, ln = pair.split(",")
            coords.append((float(la), float(ln)))
        except ValueError:
            continue
    coords = coords[:24]
    if not coords:
        return jsonify(results=[])

    results = [None] * len(coords)
    misses = []
    with _locality_lock:
        for i, (la, ln) in enumerate(coords):
            key = _cell(la, ln)
            if key in _locality_cache:
                results[i] = {"lat": la, "lng": ln, "name": _locality_cache[key]}
            else:
                misses.append(i)

    if misses:
        with ThreadPoolExecutor(max_workers=8) as pool:
            futs = {pool.submit(_reverse_locality, *coords[i]): i for i in misses}
            for f in as_completed(futs):
                i = futs[f]
                try:
                    name = f.result()
                except Exception:  # noqa: BLE001
                    name = ""
                results[i] = {"lat": coords[i][0], "lng": coords[i][1], "name": name}
        _cache_flush()             # share this batch's new names with the other workers
    # Never hand back a null hole: the client keys off the name being non-empty
    # to decide whether a row is still resolving, so a gap here reads as a
    # permanent spinner.
    for i, (la, ln) in enumerate(coords):
        if results[i] is None:
            results[i] = {"lat": la, "lng": ln, "name": ""}
    resp = jsonify(results=results)
    # These are stable place names for a 110 m cell — worth a browser-side cache
    # so a reload does not re-ask, but not so long that a corrected name sticks.
    resp.cache_control.private = True
    resp.cache_control.max_age = 3600
    return resp


@bp.route("/api/route")
def route_proxy():
    """Proxy Mappls route_adv (the browser cannot call it directly — CORS)."""
    pts = request.args.get("pts", "")
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

    url = (
        f"https://apis.mappls.com/advancedmaps/v1/{mappls_api_key()}"
        f"/route_adv/driving/{urllib.parse.quote(pts, safe=',;.')}"
        f"?geometries=geojson&overview=full"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "FloodTwin/2.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return Response(resp.read(), mimetype="application/json")
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=str(exc)), 502
