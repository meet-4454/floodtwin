"""FloodTwin application factory.

The Flask side is now purely a data + API server: it streams the simulation
binaries and drainage inventories, proxies every keyed third-party API so no key
reaches the browser, and serves the built React bundle. All rendering lives in
web/ (Vite + React); nothing here templates HTML any more.

Production entry point: `gunicorn -c gunicorn.conf.py server:app`. See DEPLOY.md.
"""
from __future__ import annotations

import logging
import sys
from datetime import timedelta

from flask import Flask, jsonify, request
from werkzeug.middleware.proxy_fix import ProxyFix

from .config import (
    BEHIND_PROXY, DEBUG_MODE, SESSION_COOKIE_SECURE, SESSION_LIFETIME_HOURS,
    STATIC_DIR, STATIC_MAX_AGE, secret_key,
)
from .routes import assets, auth, data, geo, pages, partner

# Text that is worth compressing on the way out. The simulation binaries are
# already gzipped by http.send_data with a cached compression, so they are
# deliberately absent here — compressing them twice would be pure CPU burn.
_COMPRESSIBLE = ("text/", "application/json", "application/javascript",
                 "application/geo+json", "image/svg+xml")
_COMPRESS_MIN_BYTES = 1024


def _configure_logging(app: Flask) -> None:
    """Send app logs to stderr in a parseable shape.

    Under gunicorn stderr is captured by the process manager (journald, Docker,
    whatever is in front), which is where operational logs belong — Flask's
    default handler only exists in the dev server.
    """
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s", "%Y-%m-%dT%H:%M:%S%z"))
    app.logger.handlers = [handler]
    app.logger.setLevel(logging.DEBUG if DEBUG_MODE else logging.INFO)
    app.logger.propagate = False


def create_app() -> Flask:
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
    app.config["JSON_SORT_KEYS"] = False
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = STATIC_MAX_AGE
    _configure_logging(app)

    if BEHIND_PROXY:
        # Without this, every request behind nginx/Cloudflare looks like it came
        # from 127.0.0.1 over http — which would make the login lockout count all
        # users as one attacker, and would stop Flask from ever marking the
        # session cookie Secure.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

    # Session cookie for the console gate. HttpOnly so no script can read it,
    # Lax so it survives a normal navigation but not a cross-site POST, Secure
    # (in production) so it is never sent in the clear.
    app.secret_key = secret_key()
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=SESSION_COOKIE_SECURE,
        PERMANENT_SESSION_LIFETIME=timedelta(hours=SESSION_LIFETIME_HOURS),
        MAX_CONTENT_LENGTH=1024 * 1024,      # nothing here accepts a large upload
    )

    # Data blueprints register first so their concrete paths win over the SPA
    # catch-all; pages.py is registered last for the same reason.
    app.register_blueprint(data.bp)
    app.register_blueprint(assets.bp)
    app.register_blueprint(auth.bp)
    app.register_blueprint(geo.bp)
    app.register_blueprint(partner.bp)
    app.register_blueprint(pages.bp)

    @app.after_request
    def _security_headers(response):
        # Cheap, universally safe hardening. No CSP: the map SDK and the WebGL
        # workers need blob: and inline styles, and a wrong CSP breaks the
        # console silently — that belongs in the reverse proxy, tuned once.
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        return response

    @app.after_request
    def _no_stale_code(response):
        # Heavy DATA files opt into long-lived caching via http.cache(); anything
        # else (HTML, API JSON) must never be served stale.
        if response.cache_control.max_age:
            return response
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    @app.after_request
    def _compress(response):
        """gzip text responses when Flask is the edge.

        The React bundle is ~600 KB of three.js that gzips to ~154 KB, and on a
        municipal connection that difference is the whole first-load experience.
        Skipped when a proxy in front already compressed, when the client did not
        ask, and for anything streamed or already encoded.
        """
        if (response.direct_passthrough
                or response.status_code >= 300
                or "Content-Encoding" in response.headers
                or "gzip" not in request.headers.get("Accept-Encoding", "")):
            return response
        ctype = (response.mimetype or "")
        if not any(ctype.startswith(p) or ctype == p for p in _COMPRESSIBLE):
            return response
        data = response.get_data()
        if len(data) < _COMPRESS_MIN_BYTES:
            return response
        import gzip
        response.set_data(gzip.compress(data, 6))
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Content-Length"] = str(len(response.get_data()))
        response.headers.add("Vary", "Accept-Encoding")
        return response

    # Warm the critical-asset cache in the background so the first console visit
    # never pays for ~96 cold Google Places calls. Never blocks startup, and a
    # file lock keeps it to ONE build across all gunicorn workers.
    assets.warm_cache_async()

    @app.errorhandler(404)
    def _not_found(_err):
        return jsonify(error="not_found"), 404

    @app.errorhandler(413)
    def _too_large(_err):
        return jsonify(error="request_too_large"), 413

    @app.errorhandler(Exception)
    def _unhandled(err):
        # Let werkzeug's own HTTP errors (405, 400, …) keep their status; only
        # genuine crashes become a 500, logged with a traceback and answered with
        # a body that leaks nothing about the internals.
        from werkzeug.exceptions import HTTPException
        if isinstance(err, HTTPException):
            return err
        app.logger.exception("unhandled error on %s %s", request.method, request.path)
        return jsonify(error="internal_error"), 500

    return app
