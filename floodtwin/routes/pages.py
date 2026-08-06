"""Serve the React bundle.

Vite builds into static/dist. Both routes ("/" landing and "/twin" console) and
any unknown path hand back the same index.html — react-router does the rest. The
catch-all deliberately runs LAST and only for paths no data blueprint claimed, so
a missing binary still 404s instead of silently returning HTML.
"""
from __future__ import annotations

import mimetypes

from flask import Blueprint, jsonify, send_from_directory

from ..config import STATIC_DIR, DIST_DIR
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


def _index():
    idx = DIST_DIR / "index.html"
    if not idx.is_file():
        return _MISSING_BUILD, 200, {"Content-Type": "text/html; charset=utf-8"}
    # Never cached: this document names the hashed chunks, so a stale copy points
    # a browser at files a rebuild has already deleted.
    return send_bundle(DIST_DIR, "index.html", "text/html; charset=utf-8", immutable=False)


@bp.route("/")
def landing():
    return _index()


@bp.route("/twin")
def console():
    return _index()


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
