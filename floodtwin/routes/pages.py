"""Serve the React bundle.

Vite builds into static/dist. Both routes ("/" landing and "/twin" console) and
any unknown path hand back the same index.html — react-router does the rest. The
catch-all deliberately runs LAST and only for paths no data blueprint claimed, so
a missing binary still 404s instead of silently returning HTML.
"""
from __future__ import annotations

import html
import json
import mimetypes
import threading

from flask import Blueprint, Response, jsonify, request, send_from_directory

from ..config import STATIC_DIR, DIST_DIR, mappls_api_key
from ..http import cache, send_bundle

bp = Blueprint("pages", __name__)

_MISSING_BUILD = """<!doctype html><meta charset="utf-8">
<title>FloodTwin — build the front-end</title>
<style>body{font-family:system-ui;background:#0b1420;color:#eef2f4;display:grid;
place-items:center;height:100vh;margin:0;text-align:center;line-height:1.7}
code{background:#142330;padding:2px 7px;border-radius:5px;color:#3fa9c9}</style>
<div><h1>Front-end not built</h1>
<p>The API and data routes are live, but <code>static/dist</code> is empty.</p>
<p>Run <code>cd web &amp;&amp; npm install &amp;&amp; npm run build</code>,<br>
or <code>npm run dev</code> for the Vite dev server on :5173.</p></div>"""


# ── index.html, with the console's cold start already in motion ──────────────
#
# Two things used to sit in front of the map, strictly one after the other:
#
#   bundle parses → fetch /api/config → inject the Mappls SDK <script> → map
#
# Neither round trip needed to be there. /api/config carries exactly one value,
# the Mappls key, and that key is NOT a secret in any meaningful sense — it is
# spelled out in the SDK url the browser fetches a moment later. So it is written
# into the document instead, which deletes a round trip AND lets the SDK — the
# single largest third-party download on the critical path — start at parse time,
# in parallel with the React bundle rather than after it.
#
# The SDK tag goes on /twin ONLY. The landing page has no map, and shipping it a
# map SDK to not use would trade one page's problem for another's; the overview's
# console links warm it on hover instead (see warmConsole.js).
_INDEX_LOCK = threading.Lock()
_index_cache: dict[tuple[bool, float], bytes] = {}


def _sdk_url(key: str) -> str:
    from urllib.parse import quote
    return (f"https://apis.mappls.com/advancedmaps/api/{quote(key, safe='')}"
            "/map_sdk?v=3.0&layer=vector")


def _render_index(raw: bytes, with_map_sdk: bool) -> bytes:
    """Inline the client config, and on the console also start the SDK download."""
    key = mappls_api_key()
    # json.dumps escapes the quotes; the </script> guard stops a key that somehow
    # contained one from closing the tag early.
    cfg = json.dumps({"mapplsApiKey": key}).replace("</", "<\\/")
    head = [f"<script>window.__FT_CONFIG={cfg};</script>"]
    if with_map_sdk:
        # The two same-origin fetches the console makes before it can draw
        # anything, started while the bundle is still being parsed. /live first
        # because that is the dataset the console opens on; /sim is the fallback
        # for when the daily forecast is missing or mid-swap, and it is ~1 KB.
        # `crossorigin` is required for as=fetch to match what fetch() issues —
        # without it the preload is a separate no-cors request and the app
        # downloads each of these twice.
        for href in ("/live/manifest.json", "/sim/manifest.json"):
            head.append(f'<link rel="preload" as="fetch" href="{href}" crossorigin>')
    if with_map_sdk and key:
        url = html.escape(_sdk_url(key), quote=True)
        # Not `defer`: the engine waits on window.mappls either way, and async
        # lets it execute the moment it lands instead of queueing behind the
        # bundle. core.js adopts this tag rather than adding a second one.
        head.append(f'<script id="ft-mappls-sdk" async src="{url}"></script>')
    return raw.replace(b"</head>", ("".join(head) + "</head>").encode("utf-8"), 1)


def _index(with_map_sdk: bool = False):
    idx = DIST_DIR / "index.html"
    if not idx.is_file():
        return _MISSING_BUILD, 200, {"Content-Type": "text/html; charset=utf-8"}

    st = idx.stat()
    ck = (with_map_sdk, st.st_mtime)
    with _INDEX_LOCK:
        body = _index_cache.get(ck)
    if body is None:
        body = _render_index(idx.read_bytes(), with_map_sdk)
        with _INDEX_LOCK:
            # Drop only entries from an EARLIER build. Clearing outright made the
            # two variants evict each other, so alternating landing and console
            # hits re-rendered on every request.
            for key in [k for k in _index_cache if k[1] != st.st_mtime]:
                del _index_cache[key]
            _index_cache[ck] = body

    # Never cached: this document names the hashed chunks, so a stale copy points
    # a browser at files a rebuild has already deleted. The generic _compress hook
    # gzips it on the way out.
    resp = Response(body, mimetype="text/html")
    resp.set_etag(f"{int(st.st_mtime)}-{len(body)}")
    resp.cache_control.no_store = True
    resp.cache_control.no_cache = True
    resp.cache_control.must_revalidate = True
    resp.cache_control.max_age = 0
    return resp.make_conditional(request)


@bp.route("/")
def landing():
    return _index()


@bp.route("/twin")
def console():
    return _index(with_map_sdk=True)


@bp.route("/static/<path:filename>")
def static_files(filename: str):
    """The logo, the stylesheet, the landing media's siblings.

    Flask's own /static route is switched off (see create_app) because the app's
    zero default max-age made every one of these no-store — a fresh 93 KB logo
    download on each page view. Revalidated instead: one conditional GET, then a
    304."""
    return cache(send_from_directory(str(STATIC_DIR), filename))


@bp.route("/assets/<path:filename>")
def bundle_assets(filename: str):
    """Hashed Vite chunks — gzipped once per build, then cached hard forever."""
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return send_bundle(DIST_DIR / "assets", filename, mime, immutable=True)


@bp.route("/media/<path:filename>")
def media(filename: str):
    """Landing-page video and poster. Already-compressed formats, so no gzip —
    just a long revalidated cache so a repeat visitor does not re-download a
    megabyte of console footage to look at the same page."""
    return cache(send_from_directory(str(STATIC_DIR / "media"), filename))


# Paths owned by the data and API blueprints. A request under one of these that
# reached the catch-all is a genuinely missing file, and must 404 as itself —
# handing back index.html would turn a missing binary into an HTML body that the
# fetch then fails to parse, which is far harder to diagnose than a 404.
_DATA_PREFIXES = (
    "api/", "sim/", "live/", "drainage/", "chunks/", "dem_tiles/",
    "assets/", "media/", "static/", "healthz",
)


@bp.route("/<path:_unmatched>")
def spa_fallback(_unmatched: str):
    """Serve the app for any unclaimed path, so deep links work.

    react-router owns "/" and "/twin" client-side, but a FRESH load of anything
    else never reached it: Flask had routes for exactly "/" and "/twin", so
    "/twin/" with a trailing slash — or a shared link with a typo — fell through
    to the JSON 404 handler and the visitor got `{"error":"not_found"}` instead
    of the console. The router's own `path="*"` cannot help, because it only runs
    once the bundle is already loaded.

    Registered last and prefix-guarded, so it catches stray page URLs without
    masking a missing data file.
    """
    if _unmatched.startswith(_DATA_PREFIXES):
        return jsonify(error="not_found"), 404
    # "/twin/" and friends land here, and they are the console — so they get the
    # console's variant, with the map SDK already in flight. Without this, every
    # shared link with a trailing slash quietly paid the slow cold start.
    return _index(with_map_sdk=_unmatched.rstrip("/") == "twin")


@bp.route("/healthz")
def healthz():
    """Readiness, not just liveness.

    A process that is up but has no front-end build or no simulation binaries
    cannot serve anybody, and a load balancer should know that before it sends
    traffic — so those two turn the check red rather than being reported as
    trivia alongside "ok".
    """
    from ..config import SIM_DIR

    checks = {
        "build": (DIST_DIR / "index.html").is_file(),
        "sim_data": (SIM_DIR / "manifest.json").is_file(),
    }
    ok = all(checks.values())
    return jsonify(status="ok" if ok else "degraded", checks=checks), (200 if ok else 503)
