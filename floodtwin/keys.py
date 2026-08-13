"""Partner API keys: the record store and the verification primitive.

WHAT A KEY IS. A key is a SECRET held by a partner's SERVER, never by a browser.
The partner's frontend calls their own origin; their server forwards the request
to us with the key attached. That is the whole reason this file can store a hash
instead of the key itself, and the reason there is no CORS machinery anywhere in
the codebase: our traffic from a partner is server-to-server.

WHAT IS STORED. Only `sha256(secret)`. The plaintext is printed once by
scripts/issue_key.py and is unrecoverable afterwards, so a leaked keys.json
cannot be replayed against us — it is a file of hashes, not of credentials.
Losing a key means issuing a new one, which is the correct trade.

WHERE RECORDS COME FROM. `FLOODTWIN_API_KEYS` (inline JSON, for platforms that
only offer env vars) or `keys.json` beside .env, following the same
env-or-file convention as config.secret_key(). Records are re-read when the file
changes on disk, so revoking a key does not need a restart.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import BASE_DIR

KEYS_PATH = Path(os.environ.get("FLOODTWIN_KEYS_FILE", BASE_DIR / "keys.json"))

# Prefix on every issued key. Purely a human affordance: it makes a leaked key
# recognisable in a log or a paste, which is what lets somebody notice and
# revoke it. It carries no authority — verification is the hash comparison.
KEY_PREFIX = "ft_live_"

# Every scope the gate can require. A key's `scopes` list is checked against the
# scope derived from the request path; "*" means all of them.
ALL_SCOPES = ("sim", "drainage", "assets", "geocode", "route", "live", "config")

# Defaults for a key issued without explicit limits. Generous for the data
# routes (a cold console load is legitimately ~40 requests in a few seconds,
# and scrubbing the timeline fetches a frame per step), tight on the billed
# endpoints, which is what `daily_quota` guards.
DEFAULT_RATE_PER_MIN = 600
DEFAULT_DAILY_QUOTA = 5000


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


@dataclass
class ApiKey:
    id: str
    name: str = ""
    secret_sha256: str = ""
    scopes: list[str] = field(default_factory=lambda: list(ALL_SCOPES))
    rate_per_min: int = DEFAULT_RATE_PER_MIN
    daily_quota: int = DEFAULT_DAILY_QUOTA
    enabled: bool = True
    created: str = ""

    def allows(self, scope: str) -> bool:
        return "*" in self.scopes or scope in self.scopes

    def to_record(self) -> dict:
        return {
            "id": self.id, "name": self.name, "secret_sha256": self.secret_sha256,
            "scopes": self.scopes, "rate_per_min": self.rate_per_min,
            "daily_quota": self.daily_quota, "enabled": self.enabled,
            "created": self.created,
        }


def _parse(records: list) -> dict[str, ApiKey]:
    """Records → {secret_sha256: ApiKey}, skipping anything malformed.

    Indexed by HASH because that is what a lookup has to go on: the gate hashes
    the presented secret and asks this dict for it. One dict read instead of a
    scan over every key, and no timing signal from the scan length.
    """
    out: dict[str, ApiKey] = {}
    for i, rec in enumerate(records or []):
        if not isinstance(rec, dict):
            continue
        digest = str(rec.get("secret_sha256") or "").strip().lower()
        if len(digest) != 64:
            continue                      # not a sha256 hex — unusable, skip
        scopes = rec.get("scopes") or list(ALL_SCOPES)
        if isinstance(scopes, str):
            scopes = [s.strip() for s in scopes.split(",") if s.strip()]
        out[digest] = ApiKey(
            id=str(rec.get("id") or f"key{i}"),
            name=str(rec.get("name") or ""),
            secret_sha256=digest,
            scopes=list(scopes),
            rate_per_min=int(rec.get("rate_per_min") or DEFAULT_RATE_PER_MIN),
            daily_quota=int(rec.get("daily_quota") or DEFAULT_DAILY_QUOTA),
            enabled=bool(rec.get("enabled", True)),
            created=str(rec.get("created") or ""),
        )
    return out


_lock = threading.Lock()
_cache: dict[str, ApiKey] = {}
_cache_mtime: float = -1.0
_cache_from_env = False


def _load_locked() -> dict[str, ApiKey]:
    """Return the current key table, re-reading keys.json if it changed.

    Caller holds _lock. The mtime check is what makes revocation take effect
    without a restart: rewrite the file, and the next request past this point
    sees the new table.
    """
    global _cache, _cache_mtime, _cache_from_env

    env = os.environ.get("FLOODTWIN_API_KEYS", "").strip()
    if env:
        # Env wins and is read once — the process cannot observe it change.
        if not _cache_from_env:
            try:
                _cache = _parse(json.loads(env))
            except (json.JSONDecodeError, TypeError):
                _cache = {}
            _cache_from_env = True
        return _cache

    try:
        mtime = KEYS_PATH.stat().st_mtime
    except OSError:
        # No key file: no partner keys exist. The session-cookie path is
        # untouched, so the console keeps working — this is a valid state, not
        # an error, and it is the state every existing deployment starts in.
        _cache, _cache_mtime = {}, -1.0
        return _cache

    if mtime != _cache_mtime:
        try:
            data = json.loads(KEYS_PATH.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            # A half-written or corrupt file must not silently disable every
            # partner. Keep serving the last good table and let the caller log.
            return _cache
        _cache = _parse(data.get("keys") if isinstance(data, dict) else data)
        _cache_mtime = mtime
    return _cache


def verify(presented: str) -> ApiKey | None:
    """Resolve a presented secret to its key record, or None.

    The hash comparison is constant-time (hmac.compare_digest) even though the
    lookup is a dict hit: the dict has already told us which record to check, so
    the only comparison left is the confirmation, and it matches how the console
    password is checked in routes/auth.py.
    """
    presented = (presented or "").strip()
    if not presented:
        return None
    digest = hash_secret(presented)
    with _lock:
        table = _load_locked()
        key = table.get(digest)
    if key is None or not key.enabled:
        return None
    if not hmac.compare_digest(key.secret_sha256, digest):
        return None                       # unreachable in practice; cheap belt
    return key


def all_keys() -> list[ApiKey]:
    """Every loaded key record. For the issuance CLI's --list."""
    with _lock:
        return list(_load_locked().values())


def write_records(keys: list[ApiKey]) -> None:
    """Persist the key table. Used by scripts/issue_key.py, not by the server."""
    payload = {
        "_comment": "FloodTwin partner API keys. Hashes only — the plaintext "
                    "keys are unrecoverable. Manage with scripts/issue_key.py.",
        "updated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "keys": [k.to_record() for k in keys],
    }
    tmp = KEYS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", "utf-8")
    try:
        tmp.chmod(0o600)
    except OSError:      # non-POSIX filesystem
        pass
    # Atomic replace: a reader hitting the file mid-write would otherwise parse
    # a truncated table and — but for the corrupt-file guard in _load_locked —
    # drop every partner at once.
    tmp.replace(KEYS_PATH)
