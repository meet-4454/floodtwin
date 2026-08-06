"""Shared response helpers: cache policy and on-the-fly gzip for the data files."""
from __future__ import annotations

import gzip as _gzip
import threading
from pathlib import Path

from flask import Response, request, send_from_directory

from .config import ONE_WEEK_SECONDS


def cache(response, max_age: int = ONE_WEEK_SECONDS, public: bool = True):
    """Make a response cacheable but revalidated.

    send_file defaults to `no-cache` (because SEND_FILE_MAX_AGE_DEFAULT=0); clear
    that and set an explicit max-age. These files were once `immutable`, which
    meant the browser kept serving a STALE binary across rebuilds — mismatched
    with freshly-loaded JS, so the water vanished and the app crashed. With
    no-cache + ETag/Last-Modified the browser does a conditional GET: a cheap 304
    when nothing changed, a fresh 200 right after a rebuild.
    """
    response.cache_control.no_store = None
    response.cache_control.max_age = max_age
    response.cache_control.public = public
    response.cache_control.no_cache = True
    response.cache_control.must_revalidate = True
    response.cache_control.immutable = None
    return response


# The simulation binaries compress dramatically (chunks are float32 depths that
# are mostly zeros), so serving them gzipped slashes the cold-load transfer.
# Compress once per file version and keep the bytes in memory.
_gzip_cache: dict[str, tuple[float, bytes]] = {}
_gzip_lock = threading.Lock()


def gzipped(path: Path) -> bytes:
    key, mtime = str(path), path.stat().st_mtime
    with _gzip_lock:
        hit = _gzip_cache.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
    data = _gzip.compress(path.read_bytes(), compresslevel=6)
    with _gzip_lock:
        _gzip_cache[key] = (mtime, data)
    return data


def send_bundle(directory, filename: str, mimetype: str, immutable: bool):
    """Serve a built front-end file, gzipped, with the right freshness policy.

    Why not the generic after_request compressor: `send_file` hands back a
    pass-through response, so a WSGI-level hook can only compress it by reading
    the whole file into memory on every single request. `gzipped()` compresses
    once per file version and keeps the bytes, which for a 600 KB three.js chunk
    (600 KB → 154 KB) is the difference between a fast first load and a slow one.

    `immutable` is for Vite's content-hashed chunks — the name changes on every
    rebuild, so the bytes behind it never do. index.html gets the opposite: it is
    the document that POINTS at those hashes, so it must never be cached, or a
    deploy never reaches an open tab.
    """
    path = Path(directory) / filename
    if not path.is_file():
        from flask import abort
        abort(404)
    st = path.stat()
    accepts_gzip = "gzip" in request.headers.get("Accept-Encoding", "")

    if accepts_gzip:
        resp = Response(gzipped(path), mimetype=mimetype)
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Vary"] = "Accept-Encoding"
    else:
        resp = Response(path.read_bytes(), mimetype=mimetype)
    resp.set_etag(f"{int(st.st_mtime)}-{st.st_size}")
    resp.last_modified = st.st_mtime

    if immutable:
        resp.cache_control.public = True
        resp.cache_control.max_age = 60 * 60 * 24 * 365
        resp.cache_control.immutable = True
    else:
        resp.cache_control.no_store = True
        resp.cache_control.no_cache = True
        resp.cache_control.must_revalidate = True
        resp.cache_control.max_age = 0
    return resp.make_conditional(request)


def send_data(directory, filename: str, mimetype: str):
    """Serve an immutable data file, gzipped when the client accepts it."""
    path = Path(directory) / filename
    if "gzip" in request.headers.get("Accept-Encoding", "") and path.is_file():
        st = path.stat()
        resp = Response(gzipped(path), mimetype=mimetype)
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Vary"] = "Accept-Encoding"
        # Validators so the no-cache revalidation can answer 304. mtime+size
        # change whenever the file is rebuilt.
        resp.set_etag(f"{int(st.st_mtime)}-{st.st_size}")
        resp.last_modified = st.st_mtime
        return cache(resp).make_conditional(request)
    return cache(send_from_directory(str(directory), filename, mimetype=mimetype))
