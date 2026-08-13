"""What a key can find out about itself: identity, limits and consumption.

Partners need this to reconcile their own usage against ours and to see how much
of the shared Mappls/Google quota they have spent — asking us by email does not
scale and is always out of date.

A key may only ever read ITS OWN record. There is no key id parameter, because
the only key this can describe is the one that authenticated the request; adding
one would turn a self-service endpoint into a way to enumerate other partners.
"""
from __future__ import annotations

import time

from flask import Blueprint, g, jsonify, request

from .. import usage
from ..gate import _BILLED_SCOPES        # the single source of truth for "billed"

bp = Blueprint("account", __name__)


@bp.route("/api/usage")
def api_usage():
    """This key's identity, limits and consumption.

    Cheap and unmetered on purpose: a partner polling their own quota must never
    be the thing that exhausts it, and must never be rate-limited out of finding
    out that they are rate-limited.
    """
    key = getattr(g, "ft_key", None)
    if key is None:
        # Reached with a console session rather than a key. There is no usage
        # record for a cookie, and saying so is clearer than an empty report.
        return jsonify(
            error="key_required",
            detail="/api/usage describes the API key that made the request. "
                   "Send one on X-FloodTwin-Key.",
        ), 401

    try:
        days = max(1, min(90, int(request.args.get("days", 30))))
    except (TypeError, ValueError):
        days = 30

    data = usage.summary(key.id, days=days)
    used = data["billed_calls_today"]
    quota = key.daily_quota

    return jsonify(
        key={
            "id": key.id,
            "name": key.name,
            "scopes": sorted(_BILLED_SCOPES | set(key.scopes)) if "*" in key.scopes else key.scopes,
            "created": key.created,
        },
        limits={
            "rate_per_min": key.rate_per_min,
            "daily_billed_quota": quota,
            # Which scopes actually draw on the shared third-party quota, so a
            # partner can tell which of their features cost us money.
            "billed_scopes": sorted(_BILLED_SCOPES),
        },
        today={
            "date": data["date"],
            "calls": data["calls_today"],
            "billed_calls": used,
            "bytes": data["bytes_today"],
            "quota_remaining": (max(0, quota - used) if quota > 0 else None),
            "quota_exhausted": bool(quota > 0 and used >= quota),
            # The counter is UTC-day based, so this is when it resets.
            "resets_at": time.strftime(
                "%Y-%m-%dT00:00:00Z", time.gmtime(time.time() + 86400)),
            "by_scope": data["by_scope"],
        },
        history=data["history"],
        server_time=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
