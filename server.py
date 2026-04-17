"""FloodTwin Flask server.

Entry point for local dev (python server.py) and production WSGI
(gunicorn server:app). Serves the SPA and streams the polygon/chunk
binary data with long-lived cache headers.
"""

import os
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, send_from_directory

BASE_DIR = Path(__file__).parent.resolve()
CHUNKS_DIR = BASE_DIR / "chunks"

DEFAULT_MAPPLS_KEY = "07ed2c801ad7e2fd64b3fdffd084b0be"
ONE_WEEK_SECONDS = 60 * 60 * 24 * 7

app = Flask(
    __name__,
    static_folder="static",
    template_folder="templates",
)
app.config["JSON_SORT_KEYS"] = False
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = ONE_WEEK_SECONDS


def _mappls_api_key() -> str:
    return os.environ.get("MAPPLS_API_KEY", DEFAULT_MAPPLS_KEY)


def _cache(response, max_age: int = ONE_WEEK_SECONDS, public: bool = True):
    response.cache_control.max_age = max_age
    response.cache_control.public = public
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
