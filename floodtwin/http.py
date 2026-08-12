"""Shared response helpers: cache policy and on-the-fly gzip for the data files."""
from __future__ import annotations

import gzip as _gzip
import threading
from pathlib import Path

from flask import Response, request, send_from_directory

from .config import ONE_WEEK_SECONDS, ONE_YEAR_SECONDS


def cache(response, max_age: int = ONE_WEEK_SECONDS, public: bool = True,
          immutable: bool = False):
    """Make a response cacheable — revalidated by default, frozen when versioned.

    send_file defaults to `no-cache` (because SEND_FILE_MAX_AGE_DEFAULT=0); clear
    that and set an explicit max-age. These files were once unconditionally
    `immutable`, which meant the browser kept serving a STALE binary across
    rebuilds — mismatched with freshly-loaded JS, so the water vanished and the
    app crashed. With no-cache + ETag/Last-Modified the browser does a
    conditional GET: a cheap 304 when nothing changed, a fresh 200 right after a
    rebuild.

    `immutable=True` is for a URL that CARRIES ITS OWN VERSION (`?v=…`, stamped
    from the dataset manifest — see routes/data.py). Correctness there comes from
    the URL rather than from asking: a rebuilt dataset publishes a new manifest,
    the version changes, and every frame URL changes with it, so a stale body can
    never be reached rather than merely being noticed late.

    The difference is not academic. Revalidating cost the app a round trip PER
    FRAME: playing a 145-frame forecast fired ~290 conditional GETs whose answer
    was always 304, and on a municipal link that is what made playback stutter
    while the bytes sat in the browser's cache the whole time. Frozen versioned
    URLs make a replay entirely local.
    """
    response.cache_control.no_store = None
    response.cache_control.public = public
    if immutable:
        response.cache_control.max_age = ONE_YEAR_SECONDS
        response.cache_control.no_cache = None
        response.cache_control.must_revalidate = None
        response.cache_control.immutable = True
        return response
    response.cache_control.max_age = max_age
    response.cache_control.no_cache = True
    response.cache_control.must_revalidate = True
    response.cache_control.immutable = None
    return response


# The simulation binaries compress dramatically (the depth grids are mostly
# zeros — 1.13 MB down to 1.4 KB when dry), so serving them gzipped slashes the
# cold-load transfer.
_gzip_cache: dict[str, tuple[float, bytes]] = {}
_gzip_lock = threading.Lock()
# Bounded, because this used to grow without limit: every distinct file ever
# requested stayed gzipped in memory, per worker, for the life of the process.
# Scrubbing one forecast pinned ~290 frame bodies in each of four workers.
_GZIP_CACHE_LIMIT = 64


def gzipped(path: Path) -> bytes:
    """The file's gzipped bytes — from a build-time sidecar when there is one.

    Compressing on demand costs 9–49 ms for a frame binary, paid on the FIRST
    request for each file IN EVERY WORKER. Playing a 145-frame forecast through
    once therefore burned ~9 s of CPU per worker in compression alone, showing
    up as a stutter on the first pass that mysteriously vanished on the second.

    So the builders now write `<name>.bin.gz` next to each binary and this
    prefers it: zero CPU, and no second copy held in RAM because the OS page
    cache already has it. The sidecar is used only when it is at least as new as
    the file it describes, so a rebuilt binary with a stale sidecar falls back to
    compressing rather than serving the previous run's bytes. Files without a
    sidecar (anything hand-dropped into the data dirs) behave exactly as before.
    """
    st = path.stat()
    key, mtime = str(path), st.st_mtime
    with _gzip_lock:
        hit = _gzip_cache.get(key)
        if hit and hit[0] == mtime:
            return hit[1]

    sidecar = path.with_name(path.name + ".gz")
    try:
        if sidecar.stat().st_mtime >= mtime:
            return sidecar.read_bytes()
    except OSError:
        pass                      # no sidecar, or it vanished mid-swap

    data = _gzip.compress(path.read_bytes(), compresslevel=6)
    with _gzip_lock:
        _gzip_cache[key] = (mtime, data)
        if len(_gzip_cache) > _GZIP_CACHE_LIMIT:
            # FIFO: dicts keep insertion order, so this drops the oldest entry.
            del _gzip_cache[next(iter(_gzip_cache))]
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
    """Serve a dataset file, gzipped when the client accepts it.

    A `?v=` on the URL means the caller stamped it with the version out of the
    dataset manifest, so the bytes behind THIS url can never change and the
    response is frozen for a year. Without one it stays revalidated, which is
    what any hand-typed or archived URL gets.
    """
    path = Path(directory) / filename
    versioned = bool(request.args.get("v"))
    if "gzip" in request.headers.get("Accept-Encoding", "") and path.is_file():
        st = path.stat()
        resp = Response(gzipped(path), mimetype=mimetype)
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Vary"] = "Accept-Encoding"
        # Validators so the no-cache revalidation can answer 304. mtime+size
        # change whenever the file is rebuilt. The suffix keeps the gzipped and
        # identity bodies on DIFFERENT etags — same file, different bytes, and a
        # shared cache that conflated them would hand one client the other's
        # encoding.
        resp.set_etag(f"{int(st.st_mtime)}-{st.st_size}-gz")
        resp.last_modified = st.st_mtime
        return cache(resp, immutable=versioned).make_conditional(request)
    resp = send_from_directory(str(directory), filename, mimetype=mimetype)
    # Same reason: tell caches this URL has more than one representation.
    resp.headers.setdefault("Vary", "Accept-Encoding")
    return cache(resp, immutable=versioned)
