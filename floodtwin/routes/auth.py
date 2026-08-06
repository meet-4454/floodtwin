"""Console access gate.

The credentials are checked HERE, on the server, and never travel to the client:
a browser-side comparison would put the password in the JS bundle, where anyone
can read it with View Source. What the browser gets back is a signed, HttpOnly
session cookie carrying nothing but "this session passed".

Scope, stated plainly: this gates the CONSOLE UI. The data endpoints (/sim/*,
/drainage/*, /api/*) stay open, because the published landing page and the
partner tooling both read them. Flip REQUIRE_AUTH_FOR_DATA on to close them too.
"""
from __future__ import annotations

import hmac
import time

from flask import Blueprint, jsonify, request, session

from ..config import console_credentials

bp = Blueprint("auth", __name__)

SESSION_KEY = "ft_console_auth"

# Wrong passwords cost real time. 96 guesses/minute is uselessly slow for an
# attacker and imperceptible to somebody who fat-fingered their password once.
_FAIL_DELAY_S = 0.6
_LOCKOUT_AFTER = 8
_LOCKOUT_S = 60
_fails: dict[str, list] = {}          # ip → [count, first_fail_ts]


def _client_ip() -> str:
    fwd = request.headers.get("X-Forwarded-For", "")
    return (fwd.split(",")[0].strip() if fwd else request.remote_addr) or "?"


def _locked(ip: str) -> int:
    """Seconds remaining on this IP's lockout, or 0."""
    rec = _fails.get(ip)
    if not rec or rec[0] < _LOCKOUT_AFTER:
        return 0
    left = int(_LOCKOUT_S - (time.time() - rec[1]))
    if left <= 0:
        _fails.pop(ip, None)
        return 0
    return left


def is_authenticated() -> bool:
    return bool(session.get(SESSION_KEY))


@bp.route("/api/auth/session")
def auth_session():
    """Cheap check the SPA runs before it mounts the console."""
    user, _ = console_credentials()
    return jsonify(authenticated=is_authenticated(),
                   user=user if is_authenticated() else None)


@bp.route("/api/auth/login", methods=["POST"])
def login():
    ip = _client_ip()
    left = _locked(ip)
    if left:
        return jsonify(error="too_many_attempts", retry_after_s=left), 429

    body = request.get_json(silent=True) or {}
    given_user = str(body.get("username") or "")
    given_pass = str(body.get("password") or "")
    want_user, want_pass = console_credentials()

    # compare_digest on BOTH, and both always evaluated: short-circuiting on the
    # username would leak which half was wrong through response timing.
    ok_user = hmac.compare_digest(given_user, want_user)
    ok_pass = hmac.compare_digest(given_pass, want_pass)
    if not (ok_user and ok_pass):
        rec = _fails.setdefault(ip, [0, time.time()])
        rec[0] += 1
        if rec[0] == _LOCKOUT_AFTER:
            rec[1] = time.time()
        time.sleep(_FAIL_DELAY_S)
        return jsonify(error="invalid_credentials"), 401

    _fails.pop(ip, None)
    session.clear()
    session[SESSION_KEY] = True
    session.permanent = True
    return jsonify(ok=True, user=want_user)


@bp.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify(ok=True)
