"""MCG partner forecast: freshness status and a server-side API proxy.

A second, independent flood-dynamics source — the coupled 2-D surface + 1-D
storm-drain model, re-run daily by the partner and published as day-ahead frames
(10-minute cadence, ~145 frames / 24 h). This module only PROXIES the partner API
so the key stays server-side, and caches responses: a given run_id/valid_time
never changes once published.

The frames the app actually plays are transcoded locally into /live by
build_live_forecast.py; this is the metadata and freshness channel.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request

from flask import Blueprint, Response, jsonify

from ..config import LIVE_DIR, PARTNER_API_KEY, PARTNER_BASE_URL

bp = Blueprint("partner", __name__)

_LATEST_TTL = 5 * 60           # run metadata: poll every 5 min
_FRAME_TTL = 24 * 60 * 60      # a published frame's data never changes
_CACHE_LIMIT = 400             # frame bodies can be tens of MB each

_lock = threading.Lock()
_cache: dict[str, dict] = {}
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,128}$")
_VALID_TIME_RE = re.compile(r"^[A-Za-z0-9]{1,32}$")


def _fetch(path: str, ttl: int):
    if not PARTNER_API_KEY:
        raise RuntimeError("partner_api_key_not_configured")
    url = f"{PARTNER_BASE_URL}{path}"
    now = time.time()
    with _lock:
        hit = _cache.get(url)
        if hit and hit["expires_at"] > now:
            return hit["body"], hit["content_type"]
    req = urllib.request.Request(url, headers={
        "X-API-Key": PARTNER_API_KEY,
        "User-Agent": "FloodTwin/2.0",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read()
        ctype = resp.headers.get("Content-Type", "application/octet-stream")
    with _lock:
        _cache[url] = {"body": body, "content_type": ctype, "expires_at": now + ttl}
        if len(_cache) > _CACHE_LIMIT:
            del _cache[min(_cache, key=lambda k: _cache[k]["expires_at"])]
    return body, ctype


@bp.route("/api/live-forecast/status")
def live_forecast_status():
    """Freshness of the built /live dataset vs what the partner currently offers.

    Anchored on the forecast WINDOW start (base_valid_time), not the run's
    generation time — that is what the UI's countdown and auto-resync key off.
    """
    built = None
    man_p = LIVE_DIR / "manifest.json"
    if man_p.is_file():
        try:
            m = json.loads(man_p.read_text())
            built = {
                "run_id": m.get("run_id"),
                "base_valid_time": m.get("base_valid_time"),
                "time_step_min": m.get("time_step_min"),
                "n_hours": m.get("n_hours"),
                "generated_at": m.get("generated_at"),
            }
        except (json.JSONDecodeError, OSError):
            built = None

    upstream, err = None, None
    try:
        body, _ = _fetch("/api/partners/floodtwin/latest", _LATEST_TTL)
        u = json.loads(body)
        upstream = {
            "run_id": u.get("run_id"),
            "base_valid_time": u.get("base_valid_time"),
            "frame_count": u.get("frame_count"),
            "status": u.get("status"),
        }
    except Exception as exc:  # noqa: BLE001 — an offline upstream must not break the UI
        err = str(exc)

    # A rebuild in flight leaves a staging dir behind; surface it so the UI can
    # say "syncing" rather than "stale".
    stage = LIVE_DIR.parent / "live_stage"
    building = stage.is_dir() and any(stage.glob("*.bin"))

    return jsonify(
        built=built, upstream=upstream, upstream_error=err, building=building,
        stale=bool(built and upstream and built["run_id"] != upstream["run_id"]),
        server_time=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    )


@bp.route("/api/live-forecast/latest")
def live_forecast_latest():
    """Latest partner run metadata: run_id + per-frame stats."""
    try:
        body, ctype = _fetch("/api/partners/floodtwin/latest", _LATEST_TTL)
    except urllib.error.HTTPError as exc:
        return jsonify(error=f"partner_http_{exc.code}"), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=str(exc)), 503 if "not_configured" in str(exc) else 502
    return Response(body, mimetype=ctype)


@bp.route("/api/live-forecast/<run_id>/geojson/<valid_time>")
def live_forecast_geojson(run_id: str, valid_time: str):
    """Full per-frame GeoJSON. These run ~50 MB/frame — the app plays the
    transcoded /live binaries instead and only hits this on explicit request."""
    if not (_RUN_ID_RE.match(run_id) and _VALID_TIME_RE.match(valid_time)):
        return jsonify(error="bad_identifier"), 404
    try:
        body, ctype = _fetch(f"/api/partners/floodtwin/{run_id}/geojson/{valid_time}", _FRAME_TTL)
    except urllib.error.HTTPError as exc:
        return jsonify(error=f"partner_http_{exc.code}"), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=str(exc)), 503 if "not_configured" in str(exc) else 502
    return Response(body, mimetype=ctype)
