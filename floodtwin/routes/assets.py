"""Critical-asset proxy: Google Places (New) primary, OSM/Overpass fallback.

Coverage over prominence: each `searchNearby` call returns at most 20 results, so
the bbox is tiled into GRID×GRID cells and every (category, tile) pair is queried
in parallel with `rankPreference: DISTANCE`, then deduped by place id. That is
what turns "the 20 best-known hospitals" into ~1,300 real assets.

CACHING — the reason this endpoint feels instant. A cold build is ~96 billed
Google calls and tens of seconds, which is far too long to make a console toggle
wait, so nothing is ever allowed to block on one:

  * in-memory + ON DISK. A process restart used to throw the whole cache away
    and make the next visitor pay for the rebuild; the disk copy survives
    restarts and deploys.
  * STALE-WHILE-REVALIDATE. Past the 6 h TTL the stale buckets are returned
    immediately and the refresh runs on a background thread. A user never waits
    for an expiry they happened to trigger — amenities do not move in a day.
  * WARMED AT STARTUP. create_app kicks off a background build for the default
    bbox, so even the very first visit after a deploy is served from cache.
  * SINGLE-FLIGHT, ACROSS PROCESSES. A thread lock only coalesces builds inside
    one worker — under gunicorn with 4 workers a cold start would fire four
    identical (billed) rebuilds. A file lock makes it one build per machine; the
    losers wait, then read what the winner wrote to disk.
"""
from __future__ import annotations

import json
import math
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import Blueprint, jsonify, request, current_app

from ..config import BASE_DIR, DEFAULT_ASSET_BBOX, google_places_api_key

bp = Blueprint("assets", __name__)

# Category → Google Place type. Keys mirror the frontend's CRITICAL_ASSETS so the
# buckets line up regardless of which backend served them.
GOOGLE_PLACE_TYPES = {
    "hospital": "hospital",
    "school": "school",
    "college": "university",   # Google has no distinct "college" type
    "fire_station": "fire_station",
    "police": "police",
    "pharmacy": "pharmacy",
}
_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby"
_MAX_RADIUS_M = 50000        # Places Nearby hard limit
_GRID = 4                    # 4×4 tiles × 6 categories ≈ 96 calls per cold refresh
_MAX_WORKERS = 8
_TTL_SECONDS = 60 * 60 * 6

_lock = threading.Lock()
_cache: dict[str, dict] = {}          # bbox → {"value": buckets, "expires_at": ts}
_building: dict[str, threading.Event] = {}   # bbox → "build finished" (single-flight)
_CACHE_FILE = BASE_DIR / "drainage" / "assets_cache.json"
_LOCK_FILE = BASE_DIR / "drainage" / ".assets_build.lock"


class _FileLock:
    """Cross-process build lock.

    `blocking=False` returns immediately when another worker holds it, which is
    what the startup warmer wants — one process builds, the rest carry on. The
    cold request path blocks instead, so it can read the winner's result rather
    than duplicate a billed rebuild. Degrades to a no-op where flock is missing
    (Windows dev boxes); the in-process thread lock still applies there.
    """

    def __init__(self, path, blocking: bool):
        self.path, self.blocking, self.fd = path, blocking, None

    def __enter__(self) -> bool:
        try:
            import fcntl
        except ImportError:
            return True
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.fd = open(self.path, "w")
            fcntl.flock(self.fd, fcntl.LOCK_EX if self.blocking
                        else fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except (OSError, BlockingIOError):
            if self.fd:
                self.fd.close()
                self.fd = None
            return False

    def __exit__(self, *_exc):
        if self.fd:
            try:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            except Exception:  # noqa: BLE001
                pass
            self.fd.close()
            self.fd = None
        return False


def _haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


def _tile_grid(south, west, north, east, n):
    """Split a bbox into n×n cells, each covered by a slightly oversized circle."""
    dlat, dlng = (north - south) / n, (east - west) / n
    centers = [
        (south + (i + 0.5) * dlat, west + (j + 0.5) * dlng)
        for i in range(n) for j in range(n)
    ]
    radius = _haversine_m(south, west, south + dlat, west + dlng) / 2.0 * 1.15
    return centers, min(max(radius, 200.0), _MAX_RADIUS_M)


def _google_tile(lat, lng, radius, gtype, key):
    body = json.dumps({
        "includedTypes": [gtype],
        "maxResultCount": 20,
        # DISTANCE, not POPULARITY: each small tile must return the POIs actually
        # inside it rather than re-surfacing the same landmarks in every tile.
        "rankPreference": "DISTANCE",
        "locationRestriction": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": radius}},
    }).encode("utf-8")
    req = urllib.request.Request(_NEARBY_URL, data=body, headers={
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.formattedAddress",
        "User-Agent": "FloodTwin/2.0",
    })
    with urllib.request.urlopen(req, timeout=12) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    out = []
    for p in data.get("places", []):
        loc = p.get("location") or {}
        if loc.get("latitude") is None or loc.get("longitude") is None:
            continue
        out.append({
            "id": p.get("id"),
            "name": (p.get("displayName") or {}).get("text") or "Unnamed",
            "lat": loc["latitude"], "lng": loc["longitude"],
            "address": p.get("formattedAddress") or "",
        })
    return out


def fetch_google(bbox: str):
    key = google_places_api_key()
    if not key:
        raise RuntimeError("GOOGLE_PLACES_API_KEY not configured")
    south, west, north, east = (float(x) for x in bbox.split(","))
    centers, radius = _tile_grid(south, west, north, east, _GRID)
    tasks = [(cat, gtype, clat, clng)
             for cat, gtype in GOOGLE_PLACE_TYPES.items()
             for (clat, clng) in centers]

    raw = {cat: [] for cat in GOOGLE_PLACE_TYPES}
    failures = 0
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        futs = {pool.submit(_google_tile, t[2], t[3], radius, t[1], key): t[0] for t in tasks}
        for fut in as_completed(futs):
            try:
                raw[futs[fut]].extend(fut.result())
            except Exception:  # noqa: BLE001 — tolerate a flaky individual tile
                failures += 1
    if failures == len(tasks):
        raise RuntimeError("all Google Places tile requests failed")

    # Dedupe by place id (tiles overlap) and trim to the rectangle (circles
    # overflow the bbox edges).
    buckets = {}
    for cat, locs in raw.items():
        seen, out = set(), []
        for l in locs:
            pid = l.get("id") or f'{l["lat"]:.6f},{l["lng"]:.6f}'
            if pid in seen or not (south <= l["lat"] <= north and west <= l["lng"] <= east):
                continue
            seen.add(pid)
            l.pop("id", None)
            out.append(l)
        buckets[cat] = out
    return buckets


_OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
ASSET_AMENITIES = {
    "hospital": ["hospital"],
    "school": ["school"],
    "college": ["college", "university"],
    "fire_station": ["fire_station"],
    "police": ["police"],
    "pharmacy": ["pharmacy"],
}


def fetch_overpass(bbox: str):
    stmts = "".join(
        f'node["amenity"="{a}"]({bbox});way["amenity"="{a}"]({bbox});'
        for amenities in ASSET_AMENITIES.values() for a in amenities
    )
    query = f"[out:json][timeout:25];({stmts});out center tags;"
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")

    last_err = None
    elements = None
    for mirror in _OVERPASS_MIRRORS:
        try:
            req = urllib.request.Request(mirror, data=data, headers={
                "User-Agent": "FloodTwin/2.0",
                "Content-Type": "application/x-www-form-urlencoded",
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                elements = json.loads(resp.read().decode("utf-8")).get("elements", [])
            break
        except Exception as exc:  # noqa: BLE001 — try the next mirror
            last_err = exc
    if elements is None:
        raise RuntimeError(f"all Overpass mirrors failed: {last_err}")

    amenity_to_cat = {a: cat for cat, ams in ASSET_AMENITIES.items() for a in ams}
    buckets = {cat: [] for cat in ASSET_AMENITIES}
    for el in elements:
        tags = el.get("tags") or {}
        cat = amenity_to_cat.get(tags.get("amenity"))
        if not cat:
            continue
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lng = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lng is None:
            continue
        buckets[cat].append({
            "name": tags.get("name") or tags.get("name:en") or "Unnamed",
            "lat": lat, "lng": lng,
            "address": ", ".join(filter(None, [
                tags.get("addr:housenumber"),
                tags.get("addr:street") or tags.get("addr:place"),
                tags.get("addr:city") or tags.get("addr:district"),
            ])),
        })
    return buckets


# ── Cache ───────────────────────────────────────────────────────────────────

def _load_disk_cache(force: bool = False) -> None:
    """Seed memory from the last good build. Best-effort: a corrupt or absent
    file just means a cold start, never a failed boot.

    `force` overwrites what is already in memory — used when another worker may
    have refreshed the file underneath us.
    """
    try:
        raw = json.loads(_CACHE_FILE.read_text("utf-8"))
    except Exception:  # noqa: BLE001
        return
    with _lock:
        for bbox, entry in (raw.get("entries") or {}).items():
            if not isinstance(entry.get("value"), dict):
                continue
            fresh = {"value": entry["value"], "expires_at": float(entry.get("expires_at") or 0)}
            if force or bbox not in _cache:
                _cache[bbox] = fresh
    with _lock:
        # A disk cache written before the bucket limit existed can be larger
        # than it; trim on load rather than carrying it forward forever.
        _evict_if_needed()


def _save_disk_cache() -> None:
    try:
        _CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            payload = {"entries": dict(_cache), "saved_at": time.time()}
        tmp = _CACHE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload), "utf-8")
        tmp.replace(_CACHE_FILE)          # atomic: a reader never sees half a file
    except Exception:  # noqa: BLE001 — the memory cache is still fine
        pass


def _build(bbox: str):
    """Google first, Overpass as fallback. Raises only if BOTH fail."""
    if google_places_api_key():
        try:
            return fetch_google(bbox)
        except Exception as exc:  # noqa: BLE001 — fall back to Overpass
            current_app.logger.warning("Google Places assets failed; using Overpass: %s", exc)
    return fetch_overpass(bbox)


def _refresh(bbox: str, app=None, wait: bool = False) -> dict | None:
    """Build and store.

    Single-flighted: the first caller builds; a caller arriving mid-build either
    waits for that result (wait=True, the cold path) or returns at once
    (wait=False, a background revalidation). Ten simultaneous cold loads
    therefore cost one set of API calls, not ten.
    """
    with _lock:
        inflight = _building.get(bbox)
        if inflight is None:
            _building[bbox] = threading.Event()
    if inflight is not None:
        if not wait:
            return None
        inflight.wait(timeout=90)
        with _lock:
            hit = _cache.get(bbox)
        return hit["value"] if hit else None

    try:
        ctx = app.app_context() if app is not None else None
        if ctx:
            ctx.push()
        try:
            # Cross-process gate. Whoever holds it does the calls; everyone else
            # either skips (background warm) or blocks and reads the result.
            with _FileLock(_LOCK_FILE, blocking=wait) as got_lock:
                if not got_lock:
                    return None
                # Another process may have just finished while we queued —
                # re-read the disk cache before paying for a rebuild.
                _load_disk_cache(force=True)
                with _lock:
                    hit = _cache.get(bbox)
                if hit and hit["expires_at"] > time.time():
                    return hit["value"]
                buckets = _build(bbox)
        finally:
            if ctx:
                ctx.pop()
        with _lock:
            _cache[bbox] = {"value": buckets, "expires_at": time.time() + _TTL_SECONDS}
            _evict_if_needed()
        _save_disk_cache()
        return buckets
    except Exception as exc:  # noqa: BLE001 — keep whatever is already cached
        (app.logger if app is not None else current_app.logger).warning(
            "critical-asset refresh failed for %s: %s", bbox, exc)
        return None
    finally:
        with _lock:
            ev = _building.pop(bbox, None)
        if ev is not None:
            ev.set()          # release anyone waiting on this build


def _refresh_async(bbox: str) -> None:
    app = current_app._get_current_object()
    threading.Thread(target=_refresh, args=(bbox, app), daemon=True,
                     name=f"assets-refresh").start()


def warm_cache_async() -> None:
    """Called once from create_app. Loads the disk cache, then rebuilds in the
    background only if it is missing or expired — so a redeploy is instant and a
    long-running server is never the thing that makes a user wait."""
    _load_disk_cache()
    bbox = DEFAULT_ASSET_BBOX
    entry = _cache.get(bbox)
    if entry and entry["expires_at"] > time.time():
        return

    def run():
        time.sleep(1.0)          # let the server finish binding its port first
        _refresh(bbox)

    threading.Thread(target=run, daemon=True, name="assets-warm").start()


# ── Bbox normalisation: the billing control ─────────────────────────────────
#
# Every DISTINCT bbox string is its own cache bucket, and filling a cold bucket
# is ~96 billed Google Places calls. Accepting arbitrary floats therefore meant
# arbitrary spend: a caller iterating bboxes — or innocently deriving one from
# the map viewport, so every pan is a new box — could run the bill up without
# ever looking like abuse. It was an unbounded memory leak for the same reason.
#
# Two bounds fix that, and neither changes what the console asks for (it sends a
# fixed bbox identical to DEFAULT_ASSET_BBOX):
#
#   SNAP  — round to _BBOX_STEP, so near-identical boxes collapse onto one
#           bucket instead of each paying for its own build.
#   CLAMP — refuse anything outside the served city. A request for Mumbai is a
#           mistake worth reporting, not something to silently answer with
#           Gurugram data after paying Google for it.
_SERVICE_AREA = (28.20, 76.70, 28.75, 77.40)   # s, w, n, e — generous around Gurugram
_BBOX_STEP = 0.01                              # ~1.1 km; caps the bucket count
_MAX_SPAN_DEG = 0.60                           # a box larger than the city is a bug
_BUCKET_LIMIT = 24                             # hard ceiling on distinct buckets


def _normalise_bbox(raw: str) -> tuple[str, str | None]:
    """Canonicalise a bbox, or return the reason it is unacceptable."""
    parts = (raw or "").strip().split(",")
    if len(parts) != 4:
        return "", "bad_bbox"
    try:
        s, w, n, e = (float(p) for p in parts)
    except ValueError:
        return "", "bad_bbox"

    if s > n:
        s, n = n, s
    if w > e:
        w, e = e, w
    if (n - s) > _MAX_SPAN_DEG or (e - w) > _MAX_SPAN_DEG:
        return "", "bbox_too_large"

    as_, aw, an, ae = _SERVICE_AREA
    if n < as_ or s > an or e < aw or w > ae:
        return "", "bbox_outside_service_area"

    # Clip to the served area, then snap outward so the requested region is
    # always covered rather than shaved.
    s, w = max(s, as_), max(w, aw)
    n, e = min(n, an), min(e, ae)
    step = _BBOX_STEP
    s = math.floor(s / step) * step
    w = math.floor(w / step) * step
    n = math.ceil(n / step) * step
    e = math.ceil(e / step) * step
    if n - s < step or e - w < step:
        return "", "bbox_too_small"
    return f"{s:.2f},{w:.2f},{n:.2f},{e:.2f}", None


def _evict_if_needed() -> None:
    """Keep the bucket count bounded. Caller holds _lock.

    Drops the soonest-to-expire bucket, matching the eviction in routes/partner.py.
    The default bbox is never the victim in practice — it is refreshed constantly,
    so its expiry is always the furthest out.
    """
    while len(_cache) > _BUCKET_LIMIT:
        del _cache[min(_cache, key=lambda k: _cache[k]["expires_at"])]


# ── Route ───────────────────────────────────────────────────────────────────

@bp.route("/api/assets")
def assets():
    """Critical assets grouped by category: {"<category>": [{name,lat,lng,address}]}.

    Always answers from cache when there is one — fresh or stale — so the console
    never blocks on an upstream API it does not control.
    """
    bbox, err = _normalise_bbox(request.args.get("bbox") or DEFAULT_ASSET_BBOX)
    if err:
        return jsonify(error=err), 400

    now = time.time()
    with _lock:
        hit = _cache.get(bbox)
        fresh = bool(hit and hit["expires_at"] > now)
        value = hit["value"] if hit else None

    if fresh:
        return jsonify(value)
    if value is not None:
        # Expired but usable: serve it now, rebuild behind the request.
        _refresh_async(bbox)
        return jsonify(value)

    # Nothing cached at all — the only path that waits, and even here concurrent
    # callers share the single in-flight build rather than each starting one.
    built = _refresh(bbox, wait=True)
    if built is not None:
        return jsonify(built)
    return jsonify(error="critical assets unavailable upstream"), 502
