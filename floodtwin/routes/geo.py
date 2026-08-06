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
_NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse"


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


def _cell(lat, lng):
    return f"{lat:.3f},{lng:.3f}"


def _reverse_locality(lat, lng):
    key = _cell(lat, lng)
    with _locality_lock:
        if key in _locality_cache:
            return _locality_cache[key]
    name = ""
    try:
        qs = urllib.parse.urlencode({"lat": lat, "lon": lng, "format": "json",
                                     "zoom": 16, "addressdetails": 1})
        req = urllib.request.Request(f"{_NOMINATIM_REVERSE}?{qs}",
                                     headers={"User-Agent": "FloodTwin/2.0 (flood DSS)"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            addr = json.loads(resp.read().decode("utf-8")).get("address") or {}
        parts = [
            addr.get("suburb") or addr.get("neighbourhood") or addr.get("residential")
            or addr.get("quarter") or addr.get("hamlet"),
            addr.get("city") or addr.get("town") or addr.get("village") or addr.get("county"),
        ]
        name = ", ".join([p for p in parts if p][:2]) or addr.get("city") or addr.get("state") or ""
    except Exception:  # noqa: BLE001 — a nameless hotspot is fine; a broken panel is not
        name = ""
    with _locality_lock:
        _locality_cache[key] = name
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
        with ThreadPoolExecutor(max_workers=4) as pool:
            futs = {pool.submit(_reverse_locality, *coords[i]): i for i in misses}
            for f in as_completed(futs):
                i = futs[f]
                try:
                    name = f.result()
                except Exception:  # noqa: BLE001
                    name = ""
                results[i] = {"lat": coords[i][0], "lng": coords[i][1], "name": name}
    return jsonify(results=results)


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
