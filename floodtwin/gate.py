"""The access gate: session OR partner key, scoped, rate-limited and metered.

WHY A before_request HOOK AND NOT DECORATORS. There are ~18 data routes across
five blueprints, and more get added whenever a dataset does. A decorator has to
be remembered on each one, and the failure mode of forgetting it is that the
route is PUBLIC — the gate fails open, silently, on exactly the endpoint nobody
reviewed. A single hook with an explicit public allowlist inverts that: a new
route is protected by default, and making something public is a deliberate edit
to a list that sits in one place and reads like a policy.

WHAT AUTHENTICATES. Either:
  * the existing console session cookie (routes/auth.py) — unchanged, so the
    /twin login and the landing page keep working exactly as before; or
  * a partner key on `X-FloodTwin-Key` or `Authorization: Bearer …`, held by the
    partner's SERVER and forwarded from there. See keys.py.

Session is checked first because it is a dict lookup against an already-parsed
cookie, while the key path hashes a secret and may re-stat keys.json.
"""
from __future__ import annotations

import threading
import time

from flask import current_app, g, jsonify, request

from . import keys as keystore
from . import usage
from .routes.auth import is_authenticated

# ── Public surface ───────────────────────────────────────────────────────────
# Everything a browser must reach BEFORE it can possibly hold a credential: the
# SPA shell, its own bundle, and the login endpoint that mints the session. Note
# these are the app's OWN assets — none of them is simulation data.
_PUBLIC_EXACT = {
    "/", "/twin", "/healthz", "/favicon.ico",
    # The public landing page renders a "forecast is fresh" badge from this, for
    # anonymous visitors. It returns freshness METADATA only — run id,
    # timestamps, two booleans — and is served from a 5-minute process cache, so
    # it costs no upstream call per request. Its heavier siblings
    # (/api/live-forecast/latest and .../geojson/<t>, which stream ~50 MB frames)
    # stay gated.
    "/api/live-forecast/status",
}
_PUBLIC_PREFIXES = ("/assets/", "/media/", "/static/", "/api/auth/")

# ── Path → scope ─────────────────────────────────────────────────────────────
# Longest prefix wins, so /api/live-forecast/ resolves to `live` and not to the
# `config` fallback. Order in this tuple is irrelevant; length decides.
_SCOPE_PREFIXES = (
    ("/sim/", "sim"),
    ("/live/", "sim"),                    # transcoded frames of the same product
    ("/chunks/", "sim"),
    ("/dem_tiles/", "sim"),
    ("/drainage/", "drainage"),
    ("/api/assets", "assets"),
    ("/api/geocode/", "geocode"),
    ("/api/locality", "geocode"),
    ("/api/route", "route"),
    ("/api/live-forecast/", "live"),
    ("/api/config", "config"),
)
_SCOPE_EXACT = {
    # Renamed in "Boundary changes": the console now loads wards and the
    # district outline as two files. The old name is kept so an archived
    # build still resolves.
    "/Gurugram_wards.geojson": "sim",
    "/Gurugram_district.geojson": "sim",
    "/wards_gurugram.geojson": "sim",
    "/polygon_index.json": "sim",
    "/coordinates.bin": "sim",
}

# Endpoints that spend real money on every miss — Google Places for the ~1,300
# critical assets, Nominatim/Google for geocoding, Mappls for routing. These are
# the ones a daily quota exists to bound; bulk data egress is bounded by the
# rate limit alone.
_BILLED_SCOPES = frozenset({"assets", "geocode", "route"})

# Endpoints any valid key may call regardless of its scopes, and which are
# neither rate-limited nor metered. A partner must always be able to ask what
# their limits are — being throttled out of discovering that you are throttled
# is a support ticket by construction.
_SELF_SERVICE = frozenset({"/api/usage"})


def is_public(path: str) -> bool:
    return path in _PUBLIC_EXACT or path.startswith(_PUBLIC_PREFIXES)


def scope_for(path: str) -> str:
    """The scope a path requires. Unknown paths get `sim` — the DEFAULT IS TO
    REQUIRE SOMETHING, so a route added tomorrow is covered rather than open."""
    if path in _SCOPE_EXACT:
        return _SCOPE_EXACT[path]
    best, best_len = "sim", -1
    for prefix, scope in _SCOPE_PREFIXES:
        if path.startswith(prefix) and len(prefix) > best_len:
            best, best_len = scope, len(prefix)
    return best


# ── Rate limit ───────────────────────────────────────────────────────────────
# In memory, per process, and deliberately so. Under gunicorn with N workers the
# effective ceiling is N× the configured rate, which is fine for what this does:
# it bounds bursts, and N× a burst bound is still a bound. Paying for shared
# state on the hot path of every binary request would cost more than it is worth.
#
# The DAILY QUOTA is the opposite case and lives in usage.py instead — it is
# reported back to the partner, so it has to be one number across all workers
# rather than four independent approximations.
_lock = threading.Lock()
_buckets: dict[str, list] = {}        # key id → [tokens, last_refill_ts]


def _take_token(key: keystore.ApiKey) -> float:
    """Consume one token. Returns 0.0 if allowed, else seconds until the next.

    A classic token bucket: `rate_per_min` tokens that refill continuously, with
    the burst capped at the same number. That shape matters here — a cold
    console load is legitimately ~40 requests in a couple of seconds (manifest,
    geometry, a frame per visible step), so a per-second limiter would throttle
    normal use while a bucket absorbs the burst and still holds the minute rate.
    """
    rate = max(1, key.rate_per_min)
    now = time.time()
    per_sec = rate / 60.0
    with _lock:
        rec = _buckets.get(key.id)
        if rec is None:
            _buckets[key.id] = [rate - 1.0, now]
            return 0.0
        tokens, last = rec
        tokens = min(float(rate), tokens + (now - last) * per_sec)
        if tokens < 1.0:
            rec[0], rec[1] = tokens, now
            return (1.0 - tokens) / per_sec
        rec[0], rec[1] = tokens - 1.0, now
        return 0.0


def _quota_available(key: keystore.ApiKey) -> bool:
    """Is there daily budget left on a billed endpoint?

    Read from the shared counter, so four workers cannot each allow a full
    quota. The read is one indexed SUM over today's rows for this key — small,
    and only on the billed endpoints, never on the bulk data path.
    """
    if key.daily_quota <= 0:
        return True                        # 0 / negative = unmetered
    return usage.billed_today(key.id) < key.daily_quota


def quota_used(key_id: str) -> int:
    return usage.billed_today(key_id)


# ── The hook ─────────────────────────────────────────────────────────────────
def _presented_key() -> str:
    direct = request.headers.get("X-FloodTwin-Key", "").strip()
    if direct:
        return direct
    auth = request.headers.get("Authorization", "").strip()
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip()
    return ""


def install(app) -> None:
    """Wire the gate into an app. Called from create_app()."""

    @app.before_request
    def _gate():
        # CORS preflight, if a direct-browser tier is ever enabled. Never
        # carries credentials, so it must answer before any auth check.
        if request.method == "OPTIONS":
            return None
        path = request.path
        if is_public(path):
            return None

        # 1) The console's own session. Unchanged behaviour for our deployment.
        if is_authenticated():
            g.ft_auth = "session"
            return None

        # 2) A partner key.
        presented = _presented_key()
        if not presented:
            return jsonify(
                error="key_required",
                detail="Send a partner key on X-FloodTwin-Key or "
                       "Authorization: Bearer. Keys are server-side credentials "
                       "— proxy this request from your backend.",
            ), 401

        key = keystore.verify(presented)
        if key is None:
            # Deliberately identical for "unknown", "malformed" and "revoked":
            # distinguishing them tells a probe which of those it is holding.
            current_app.logger.warning(
                "rejected key on %s %s from %s", request.method, path, _client_ip())
            return jsonify(error="invalid_key"), 401

        # Identified from here on, so EVERY outcome below — allowed, scope-denied,
        # throttled, over quota — is attributed and shows up in /api/usage. A
        # partner debugging a 403 loop can then see the 403s; setting this only on
        # the success path (as it was) made exactly the failures they need to
        # diagnose the ones that left no trace.
        g.ft_auth = "key"
        g.ft_key = key
        g.ft_started = time.perf_counter()

        # Self-service endpoints short-circuit before scope, rate and quota.
        if path in _SELF_SERVICE:
            g.ft_scope = "account"
            return None

        scope = scope_for(path)
        g.ft_scope = scope
        if not key.allows(scope):
            return jsonify(error="scope_denied", scope=scope,
                           granted=key.scopes), 403

        wait = _take_token(key)
        if wait > 0:
            resp = jsonify(error="rate_limited", scope=scope,
                           limit_per_min=key.rate_per_min,
                           retry_after_s=round(wait, 2))
            resp.headers["Retry-After"] = str(max(1, int(wait + 0.999)))
            return resp, 429

        if scope in _BILLED_SCOPES and not _quota_available(key):
            resp = jsonify(error="quota_exceeded", scope=scope,
                           daily_quota=key.daily_quota)
            # Seconds to the next UTC day — when the counter actually resets.
            resp.headers["Retry-After"] = str(int(86400 - (time.time() % 86400)))
            return resp, 429

        return None

    @app.after_request
    def _audit(response):
        """Log and COUNT one keyed request: who, what, outcome, how long, how big.

        Counted here rather than in the before_request hook because only here is
        the outcome known — a request that 404s or errors should not spend a
        partner's billed quota, and the byte count is what makes egress
        reportable.

        Only key traffic is recorded. Session requests are our own console; they
        would drown the signal and are not billed to anyone.
        """
        key = getattr(g, "ft_key", None)
        if key is not None:
            scope = getattr(g, "ft_scope", "?")
            started = getattr(g, "ft_started", None)
            ms = (time.perf_counter() - started) * 1000 if started else -1
            failed = response.status_code >= 400

            # Content-Length is absent on streamed/passthrough responses; 0 is
            # the honest answer there rather than a guess.
            try:
                nbytes = int(response.headers.get("Content-Length") or 0)
            except ValueError:
                nbytes = 0

            # A failed billed call cost us nothing upstream, so it must not
            # consume quota — but it is still recorded, so a partner debugging a
            # 403 loop can see it.
            usage.record(key.id, scope,
                         billed=(scope in _BILLED_SCOPES and not failed),
                         nbytes=nbytes, error=failed)

            current_app.logger.info(
                "key=%s scope=%s %s %s -> %s %.1fms %dB quota=%d/%d",
                key.id, scope, request.method, request.path,
                response.status_code, ms, nbytes,
                quota_used(key.id), key.daily_quota)
        return response


def _client_ip() -> str:
    fwd = request.headers.get("X-Forwarded-For", "")
    return (fwd.split(",")[0].strip() if fwd else request.remote_addr) or "?"
